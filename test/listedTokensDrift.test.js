/**
 * Listed tokens: one list, three copies that must agree.
 *
 * The site reads web/lib/listedTokens.ts, the chat bot reads lib/listedTokens.js
 * (web/ cannot import root lib/ on Vercel), and deployments/giwa-sepolia.json
 * records what was deployed and seeded. A token in one and not the others would
 * trade without the warning on one surface and with it on another, or point the
 * app at a pool that does not exist.
 *
 * Run: node --test test/listedTokensDrift.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { registerHooks } = require('node:module');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WEB_LIB = pathToFileURL(path.join(ROOT, 'web', 'lib') + path.sep).href;

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

const chat = require('../lib/listedTokens');
let site;

before(async () => {
  site = await import('../web/lib/listedTokens.ts');
});

describe('listed tokens, site, chat and deployment record', () => {
  it('are the same tokens on the site and in chat', () => {
    assert.deepEqual(
      site.LISTED_TOKENS.map((t) => ({ ...t })),
      chat.LISTED_TOKENS.map((t) => ({ ...t }))
    );
  });

  it('match the seeded pools in deployments/giwa-sepolia.json', () => {
    const recorded = JSON.parse(read('deployments/giwa-sepolia.json')).listings.tokens;
    assert.deepEqual(Object.keys(recorded).sort(), chat.LISTED_TOKENS.map((t) => t.symbol).sort());
    for (const token of chat.LISTED_TOKENS) {
      const entry = recorded[token.symbol];
      assert.equal(entry.address, token.address, `${token.symbol} address`);
      assert.equal(entry.pairWeth, token.pair, `${token.symbol} pair`);
      assert.equal(entry.decimals, token.decimals, `${token.symbol} decimals`);
      assert.equal(entry.name, token.name, `${token.symbol} name`);
    }
  });

  it('hold checksummed addresses, upper-case symbols and no FLZ', () => {
    for (const token of chat.LISTED_TOKENS) {
      assert.equal(ethers.getAddress(token.address), token.address);
      assert.equal(ethers.getAddress(token.pair), token.pair);
      assert.equal(token.symbol, token.symbol.toUpperCase());
      assert.notEqual(token.symbol, 'FLZ');
    }
  });

  it('look tokens up by address and symbol in any casing, on both sides', () => {
    for (const lib of [chat, site]) {
      assert.equal(lib.listedByAddress('0x8ca7a8f78abc8da471df82be4f374e1661e34473').symbol, 'IZY');
      assert.equal(lib.listedBySymbol(' maki ').address, '0xd08d83cdf19Db8CCd53Ed462034c8631De5F693d');
      assert.equal(lib.listedBySymbol('dcat').pair, '0x3083C7Aa86Bc20256439c102156E7fCbe7b91797');
      assert.equal(lib.listedByAddress('0x308be8f71DA695f18E70D2243a446e1fD1566BA6'), null);
      assert.equal(lib.listedBySymbol('FLZ'), null);
      assert.equal(lib.listedByAddress(null), null);
      assert.equal(lib.listedBySymbol(''), null);
    }
  });
});

describe('listed tokens resolve by symbol and print by symbol', () => {
  let dexServer;
  const dex = require('../lib/dex');
  before(async () => {
    dexServer = await import('../web/lib/dexServer.ts');
  });

  it('resolve DCAT, IZY and MAKI to their contracts in chat and on the site', () => {
    for (const token of chat.LISTED_TOKENS) {
      assert.equal(dex.resolveToken(token.symbol.toLowerCase(), 'giwa_sepolia'), token.address);
      assert.equal(dexServer.resolveToken(token.symbol.toLowerCase()), token.address);
      assert.equal(dex.tokenLabel(token.address.toLowerCase(), 'giwa_sepolia'), token.symbol);
      assert.equal(dexServer.tokenLabel(token.address.toLowerCase()), token.symbol);
    }
  });

  it('still refuse an unknown symbol, naming what is accepted', () => {
    assert.throws(() => dex.resolveToken('NOPE', 'giwa_sepolia'), /Use ETH, FLZ, DCAT, IZY, MAKI, or a 0x address/);
    assert.throws(() => dexServer.resolveToken('NOPE'), /Use ETH, FLZ, DCAT, IZY, MAKI, or a 0x address/);
  });

  it('know listed decimals without asking the contract', async () => {
    const provider = { call: () => { throw new Error('no chain in this test'); } };
    for (const token of chat.LISTED_TOKENS) {
      assert.equal(await dexServer.readErc20Decimals(provider, token.address), token.decimals);
    }
  });
});

describe('listed tokens on the site', () => {
  it('are listed by /api/tokens from their own pools, after FLZ', () => {
    const route = read('web/app/api/tokens/route.ts');
    assert.match(route, /LISTED_TOKENS\.map\(\(token\) => cachedListedDay\(token\.address\)\.catch\(\(\) => null\)\)/);
    assert.match(route, /address: token\.address, verified: false \}/);
    const cache = read('web/lib/flzMarketCache.ts');
    assert.match(cache, /loadTokenDay\(\{ token: listed\.address, pair: listed\.pair/);
  });

  it('open by contract from Explore, Home and search, and trade from their page', () => {
    const explore = read('web/components/ExploreTokens.tsx');
    assert.match(explore, /const href = `\/dashboard\/explore\/tokens\/\$\{address\}`;\n  return \{ \.\.\.flzRow\(t\), href, trade: href \};/);
    assert.match(explore, /base\.map\(\(t\) => \(t\.address \? listedRow\(t, t\.address\) : flzRow\(t\)\)\)/);
    assert.match(read('web/components/TrendingTokens.tsx'), /href: `\/dashboard\/explore\/tokens\/\$\{t\.address \|\| t\.symbol\.toLowerCase\(\)\}`/);
    assert.match(read('web/lib/siteSearch.ts'), /POOL_LISTED\.map\(\(t\) => \(\{ symbol: t\.symbol, name: t\.name, key: t\.address \}\)\)/);
  });

  it('show as Listed, not as unverified, on the token page and in the trade sheet', () => {
    const detail = read('web/components/TokenDetail.tsx');
    assert.match(detail, /const seeded = imported && held\?\.listed === true;/);
    assert.match(detail, /listed=\{seeded\}/);
    assert.match(detail, /It is not verified, so it cannot be\s+sent on socials\./);
    assert.match(read('web/components/TokenTradeSheet.tsx'), /\{tokenAddress && !listed \? \(/);
  });

  it('are read for every wallet, so a bought token shows without adding it', () => {
    const holdings = read('web/app/api/holdings/route.ts');
    assert.match(holdings, /\.\.\.LISTED_TOKENS\.map\(\(t\) => \(\{ address: t\.address, symbol: t\.symbol, decimals: t\.decimals, verified: false \}\)\)/);
  });
});
