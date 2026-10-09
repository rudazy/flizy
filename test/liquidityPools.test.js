/**
 * Site liquidity: add to or remove from the FLZ pool or any listed token's
 * pool, picked on the Liquidity panel. Nothing else: the route refuses a pasted
 * contract before it asks for the password or takes the account lock.
 *
 * Run: node --test test/liquidityPools.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');
const { ethers } = require('ethers');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WEB_LIB = pathToFileURL(path.join(ROOT, 'web', 'lib') + path.sep).href;
const { LISTED_TOKENS } = require('../lib/listedTokens');

// Next resolves extensionless relative imports inside web/lib; plain node does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL || '';
    if (parent.startsWith(WEB_LIB) && specifier.startsWith('.') && !path.extname(specifier)) {
      const candidate = new URL(`${specifier}.ts`, parent);
      if (fs.existsSync(candidate)) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

let dex;
before(async () => {
  dex = await import('../web/lib/dexServer.ts');
});

describe('liquidityPool', () => {
  it('is the FLZ pool by default and by name', () => {
    const d = dex.getDexAddresses();
    for (const name of [null, undefined, '', 'flz', ' FLZ ']) {
      assert.deepEqual(dex.liquidityPool(name), { symbol: 'FLZ', token: d.flz, pair: d.pair, decimals: 18 });
    }
  });

  it('is each listed token pool, by symbol in any casing', () => {
    for (const token of LISTED_TOKENS) {
      assert.deepEqual(dex.liquidityPool(token.symbol.toLowerCase()), {
        symbol: token.symbol,
        token: ethers.getAddress(token.address),
        pair: ethers.getAddress(token.pair),
        decimals: token.decimals,
      });
    }
  });

  it('refuses anything else, including a pasted contract', () => {
    for (const name of ['ETH', 'WETH', 'USDC', LISTED_TOKENS[0].address, '0x2222222222222222222222222222222222222222']) {
      assert.equal(dex.liquidityPool(name), null, name);
    }
  });
});

describe('POST and GET /api/swap/liquidity', () => {
  const route = read('web/app/api/swap/liquidity/route.ts');

  it('resolves the pool first, before the password or the lock', () => {
    const pool = route.indexOf("const pool = liquidityPool(body.token == null ? null : String(body.token));");
    const refused = route.indexOf('if (!pool) return NextResponse.json({ error: NOT_A_POOL }, { status: 400 });', pool);
    assert.ok(pool > 0 && refused > pool);
    assert.ok(refused < route.indexOf('await requirePassword('));
    assert.ok(refused < route.indexOf('await tryAccountTxLock('));
    assert.doesNotMatch(route, /resolveToken\(/);
  });

  it('reads, adds and removes in that pool only', () => {
    assert.match(route, /const pool = liquidityPool\(new URL\(req\.url\)\.searchParams\.get\('token'\)\);/);
    assert.equal((route.match(/getLpPosition\(provider, walletAddr, pool\)/g) || []).length, 2);
    assert.match(route, /const tokenAddress = pool\.token;/);
    assert.match(route, /tokenWei = ethers\.parseUnits\(amountToken, pool\.decimals\);/);
    assert.equal((route.match(/\n\s*pool,\n\s*liquidityWei,/g) || []).length, 2);
    assert.match(route, /note: `Liquidity removed\. ETH and \$\{pool\.symbol\} returned to your Flizy wallet\.`/);
  });

  it('removes through the chosen pair and token, on both wallet paths', () => {
    const server = read('web/lib/dexServer.ts');
    assert.match(server, /const pair = new ethers\.Contract\(args\.pool\.pair, PAIR_ABI, args\.signer\);/);
    assert.match(server, /const pairRead = new ethers\.Contract\(args\.pool\.pair, PAIR_ABI, args\.provider\);/);
    assert.equal((server.match(/removeLiquidityETH\(\n?\s*args\.pool\.token,/g) || []).length, 1);
    assert.match(server, /encodeFunctionData\('removeLiquidityETH', \[\n\s*args\.pool\.token,/);
    assert.doesNotMatch(server, /removeLiquidityETH\(\n\s*d\.flz/);
  });
});

describe('Liquidity panel', () => {
  const page = read('web/app/dashboard/swap/page.tsx');

  it('lets the person pick the pool, and works in the one they picked', () => {
    assert.match(page, /<div className="grid grid-cols-4 gap-\[5px\]" role="radiogroup" aria-label="Pool">/);
    assert.match(page, /assets=\{\[\.\.\.SWAP_ASSETS\]\}\n\s*onAsset=\{chooseAsset\}/);
    assert.match(page, /fetch\(`\/api\/swap\/liquidity\?token=\$\{encodeURIComponent\(asset\)\}`\)/);
    assert.match(page, /const position = lpPosition && lpPosition\.symbol === asset \? lpPosition : null;/);
    assert.match(page, /runLiquidity\(\{ action: 'add', amountEth: lpEth, amountToken: lpToken, token: asset \}, 'Liquidity failed'\)/);
    assert.match(page, /runLiquidity\(\{ action: 'remove', percent: lpPercent, token: asset \}, 'Remove liquidity failed'\)/);
  });

  it('refills the token amount at the new pool price when the pool changes', () => {
    assert.match(page, /if \(mode !== 'liquidity' \|\| !price \|\| lpFilledFor\.current === asset\) return;/);
  });
});
