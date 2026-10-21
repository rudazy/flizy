/**
 * Wallet mode: a visitor's own wallet can browse and trade without a Flizy
 * account, and nothing in it reaches a Flizy-held key or the withdraw path.
 *
 *   - the page list in web/lib/walletMode.ts, loaded for real
 *   - FLZ and WETH in web/lib/walletChain.ts equal the deployment record
 *   - the market route only plans for a wallet (nothing sent, no session used)
 *   - the browser sends exactly the planned calls, and swaps approve one amount
 *   - each marketplace transaction is announced once (market_tx_notices), and
 *     only while it is recent
 *   - anonymous callers are capped per hour (web/lib/callerLimit.ts, run for
 *     real against a fake Supabase client)
 *
 * Route handlers need a Next runtime, so their order is read from source, the
 * same way test/nftMarketRoutes.test.js does.
 *
 * Run: node --test test/walletMode.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('the wallet-mode pages', () => {
  let mode;
  before(async () => {
    mode = await import('../web/lib/walletMode.ts');
  });

  it('opens browsing and trading', () => {
    for (const p of [
      '/dashboard/swap',
      '/dashboard/swap?from=ETH',
      '/dashboard/explore',
      '/dashboard/explore/',
      '/dashboard/explore/tokens/FLZ',
      '/dashboard/explore/nfts',
      '/dashboard/explore/nfts/0x0000000000000000000000000000000000000001',
      '/dashboard/explore/nfts/0x0000000000000000000000000000000000000001/7',
    ]) {
      assert.equal(mode.isWalletModePath(p), true, p);
    }
  });

  it('keeps everything that needs a Flizy account behind one', () => {
    for (const p of [
      '/dashboard',
      '/dashboard/wallet',
      '/dashboard/account',
      '/dashboard/pay',
      '/dashboard/requests',
      '/dashboard/explore/nfts/create',
      '/dashboard/explore/nfts/me',
      '/dashboard/explore/nfts/mints',
      '/dashboard/explore/nfts/mint/abc',
      '/dashboard/explore/nfts/mints/abc',
      '/dashboard/explore/tokens/FLZ/extra',
      '',
      null,
      undefined,
    ]) {
      assert.equal(mode.isWalletModePath(p), false, String(p));
    }
  });

  it('lands on a wallet-mode page', () => {
    assert.equal(mode.isWalletModePath(mode.WALLET_MODE_HOME), true);
  });
});

describe('the chain constants', () => {
  it('FLZ and WETH match the deployment record', () => {
    const record = JSON.parse(read('deployments', 'giwa-sepolia.json'));
    const chain = read('web', 'lib', 'walletChain.ts');
    const flz = chain.match(/export const FLZ_TOKEN = '(0x[0-9a-fA-F]{40})';/)[1];
    const weth = chain.match(/export const WETH_TOKEN = '(0x[0-9a-fA-F]{40})';/)[1];
    assert.equal(flz, record.contracts.flz);
    assert.equal(weth, record.contracts.weth);
  });
});

describe('money never leaves a Flizy wallet from wallet mode', () => {
  const WALLET_FILES = [
    ['web', 'lib', 'walletChain.ts'],
    ['web', 'lib', 'walletTrade.ts'],
    ['web', 'lib', 'walletMode.ts'],
    ['web', 'components', 'ExternalWalletProvider.tsx'],
    ['web', 'components', 'WalletModeBits.tsx'],
    ['web', 'components', 'OwnWalletPanel.tsx'],
  ];

  it('site withdraw is still refused', () => {
    const src = read('web', 'app', 'api', 'withdraw', 'route.ts');
    assert.match(src, /code: 'WITHDRAW_WHATSAPP_ONLY'/);
    assert.match(src, /\{ status: 403 \}/);
  });

  it('no wallet-mode file calls the withdraw route or a send route', () => {
    for (const parts of WALLET_FILES) {
      const src = read(...parts);
      // A comment may point at the withdraw route; a request to it may not.
      assert.doesNotMatch(src, /fetch\(\s*[`'"]\/api\/withdraw/, parts.join('/'));
      assert.doesNotMatch(src, /fetch\(\s*[`'"]\/api\/pay\/execute/, parts.join('/'));
    }
  });

  it('the own-wallet panel only deposits into the Flizy wallet, and sends back through the trusted list', () => {
    const src = read('web', 'components', 'OwnWalletPanel.tsx');
    assert.match(src, /const to = flizyAddress as `0x\$\{string\}`;/);
    assert.match(src, /onTrust\(own\)/);
  });
});

describe('the market route plans for a wallet without sending', () => {
  const ROUTE = read('web', 'app', 'api', 'market', '[action]', 'route.ts');
  const plan = ROUTE.slice(ROUTE.indexOf('async function planForWallet'), ROUTE.indexOf('export async function POST'));
  const post = ROUTE.slice(ROUTE.indexOf('export async function POST'));

  it('refuses a signed-in caller first, so one person never has two wallets in play', () => {
    const refuse = plan.indexOf('{ status: 409 }');
    assert.ok(refuse > 0);
    assert.ok(refuse < plan.indexOf('buildPlan('));
  });

  it('takes the plan branch after the origin check and before the session gate', () => {
    const branch = post.indexOf("searchParams.get('plan') === '1'");
    assert.ok(branch > 0);
    assert.ok(post.indexOf('rejectIfCrossOrigin(req)') < branch);
    assert.ok(branch < post.indexOf("{ error: 'Not logged in' }"));
  });

  it('plans with the same checks, for the wallet it was given, and sends nothing', () => {
    assert.match(plan, /const wallet = checkAddress\(field\(body, 'wallet'\)\);/);
    assert.match(plan, /buildPlan\(action, body, ctx, ctx\.market\.address, wallet\)/);
    assert.match(plan, /if \(paused && !exits\)/);
    for (const forbidden of ['runMarketCalls(', 'requireStepUp(', 'tryAccountTxLock(', "from('transfers')", 'viewerWallet(']) {
      assert.ok(!plan.includes(forbidden), `planForWallet must not use ${forbidden}`);
    }
  });
});

describe('the plan is capped per caller', () => {
  it('counts the call after the cheap refusals and before any chain read', () => {
    const ROUTE = read('web', 'app', 'api', 'market', '[action]', 'route.ts');
    const plan = ROUTE.slice(ROUTE.indexOf('async function planForWallet'), ROUTE.indexOf('export async function POST'));
    const cap = plan.indexOf("takeCallerAttempt(getSupabase(), req.headers, 'plan')");
    assert.ok(cap > 0);
    assert.ok(plan.indexOf('{ status: 409 }') < cap);
    assert.ok(cap < plan.indexOf('buildPlan('));
    assert.ok(cap < plan.indexOf('marketContract.paused()'));
  });
});

describe('the browser sends what was planned', () => {
  const TRADE = read('web', 'lib', 'walletTrade.ts');

  it('NFT trades send the server plan, in order, stopping at a failure', () => {
    assert.ok(TRADE.includes('fetch(`/api/market/${encodeURIComponent(action)}?plan=1`'));
    assert.ok(TRADE.includes('body: JSON.stringify({ ...body, wallet: account })'));
    assert.ok(TRADE.includes("throw new Error('The transaction failed on chain. Nothing more was sent.')"));
  });

  it('swaps pay the signer and approve only the amount being swapped', () => {
    assert.ok(TRADE.includes('args: [minOut, path, account, deadline]'));
    assert.ok(TRADE.includes('args: [amountIn, minOut, path, account, deadline]'));
    assert.ok(TRADE.includes("functionName: 'approve', args: [router, amountIn]"));
    assert.doesNotMatch(TRADE, /maxUint256|MaxUint256/);
  });
});

describe('each marketplace transaction is announced once', () => {
  const MARKET = read('web', 'lib', 'walletMarket.ts');
  const NOTICE = read('web', 'app', 'api', 'market', 'notice', 'route.ts');
  const ROUTE = read('web', 'app', 'api', 'market', '[action]', 'route.ts');
  const MIGRATION = read('supabase', 'migrations', '20261022120000_market_tx_notices.sql');

  it('a claim inserts the hash once and reports only the first', () => {
    assert.ok(MARKET.includes(".upsert({ tx_hash: txHash.toLowerCase() }, { onConflict: 'tx_hash', ignoreDuplicates: true })"));
    assert.match(MIGRATION, /tx_hash text primary key/);
    assert.ok(MIGRATION.includes("check (tx_hash ~ '^0x[0-9a-f]{64}$')"));
  });

  it('the table is service role only and the migration checks itself', () => {
    assert.match(MIGRATION, /enable row level security/);
    assert.match(MIGRATION, /revoke all on table public\.market_tx_notices from anon, authenticated;/);
    assert.match(MIGRATION, /do \$\$[\s\S]*raise exception/);
  });

  it('a wallet trade is claimed only after it succeeded on chain', () => {
    const fn = MARKET.slice(MARKET.indexOf('export async function noticeWalletTrade'));
    assert.ok(fn.indexOf('receipt.status !== 1') < fn.indexOf('claimNotice('));
    assert.ok(fn.indexOf('claimNotice(') < fn.indexOf('noticeSales('));
  });

  it('an old trade is never announced, so history cannot be replayed into chat', () => {
    const fn = MARKET.slice(MARKET.indexOf('export async function noticeWalletTrade'));
    assert.ok(MARKET.includes('export const NOTICE_WINDOW_S = 60 * 60;'));
    const window = fn.indexOf('block.timestamp > NOTICE_WINDOW_S) return false;');
    assert.ok(window > 0);
    assert.ok(fn.indexOf('receipt.status !== 1') < window);
    assert.ok(window < fn.indexOf('claimNotice('));
  });

  it('offers are read from the marketplace log only', () => {
    assert.ok(MARKET.includes('if (!log.address || ethers.getAddress(log.address) !== market) continue;'));
  });

  it('the notice route checks origin, rate and the hash before reading the chain', () => {
    const order = ['rejectIfCrossOrigin(req)', "takeCallerAttempt(supabase, req.headers, 'notice')", 'TX_HASH_RE.test(txHash)', 'noticeWalletTrade('].map((n) => {
      const i = NOTICE.indexOf(n);
      assert.ok(i >= 0, `missing: ${n}`);
      return i;
    });
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], `step ${i} out of order`);
  });

  it('Flizy-wallet trades claim the hash before announcing', () => {
    const claim = ROUTE.indexOf('const announce = await claimNotice(');
    assert.ok(claim > 0);
    assert.ok(claim < ROUTE.indexOf('if (announce && plan.offerTo)'));
    assert.ok(claim < ROUTE.indexOf("if (announce && (action === 'buy' || action === 'offer-accept'))"));
  });
});

describe('anonymous callers are capped', () => {
  let limit;
  before(async () => {
    limit = await import('../web/lib/callerLimit.ts');
  });

  /** external_pay_attempts in memory: count with a time filter, insert, and delete older rows. */
  function fakeDb({ failRead = false, failInsert = false } = {}) {
    const rows = [];
    const client = {
      rows,
      now: Date.now(),
      from(table) {
        assert.equal(table, 'external_pay_attempts');
        return {
          select(_cols, opts) {
            assert.deepEqual(opts, { count: 'exact', head: true });
            const filters = [];
            const q = {
              eq(col, v) {
                filters.push((r) => r[col] === v);
                return q;
              },
              gte(col, v) {
                filters.push((r) => r[col] >= v);
                if (failRead) return Promise.resolve({ count: null, error: { message: 'down' } });
                return Promise.resolve({ count: rows.filter((r) => filters.every((f) => f(r))).length, error: null });
              },
            };
            return q;
          },
          insert(row) {
            if (failInsert) return Promise.resolve({ error: { message: 'down' } });
            rows.push({ ...row, created_at: new Date(client.now).toISOString() });
            return Promise.resolve({ error: null });
          },
          delete() {
            return {
              lt(col, v) {
                for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i][col] < v) rows.splice(i, 1);
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    };
    return client;
  }
  const headers = (ip) => new Headers({ 'x-real-ip': ip });
  const never = () => 1;

  it('allows each bucket its cap per hour, per caller, then refuses', async () => {
    const db = fakeDb();
    db.now = Date.parse('2026-10-21T12:00:00Z');
    for (let i = 0; i < limit.CALLER_CAPS.notice; i += 1) {
      assert.equal(await limit.takeCallerAttempt(db, headers('203.0.113.7'), 'notice', db.now, never), true);
    }
    assert.equal(await limit.takeCallerAttempt(db, headers('203.0.113.7'), 'notice', db.now, never), false);
    assert.equal(await limit.takeCallerAttempt(db, headers('203.0.113.8'), 'notice', db.now, never), true, 'another caller is not affected');
    assert.equal(await limit.takeCallerAttempt(db, headers('203.0.113.7'), 'plan', db.now, never), true, 'another bucket is not affected');
    assert.equal(await limit.takeCallerAttempt(db, headers('203.0.113.7'), 'notice', db.now + 3601e3, never), true, 'the hour rolls over');
  });

  it('keys rows by bucket and a hashed address, never the address itself', async () => {
    const db = fakeDb();
    await limit.takeCallerAttempt(db, headers('203.0.113.7'), 'read', db.now, never);
    assert.match(db.rows[0].ip_key, /^read:[0-9a-f]{64}$/);
    assert.ok(!db.rows[0].ip_key.includes('203.0.113.7'));
  });

  it('plans and notices refuse on an unreadable counter; reads go through', async () => {
    for (const bucket of ['plan', 'notice']) {
      assert.equal(await limit.takeCallerAttempt(fakeDb({ failRead: true }), headers('1.1.1.1'), bucket, Date.now(), never), false, bucket);
      assert.equal(await limit.takeCallerAttempt(fakeDb({ failInsert: true }), headers('1.1.1.1'), bucket, Date.now(), never), false, bucket);
    }
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(await limit.takeCallerAttempt(fakeDb({ failRead: true }), headers('1.1.1.1'), 'read', Date.now(), never), true);
    } finally {
      console.warn = warn;
    }
  });

  it('clears rows older than a day now and then', async () => {
    const db = fakeDb();
    db.now = Date.parse('2026-10-19T00:00:00Z');
    await limit.takeCallerAttempt(db, headers('1.1.1.1'), 'read', db.now, never);
    db.now = Date.parse('2026-10-21T00:00:00Z');
    await limit.takeCallerAttempt(db, headers('1.1.1.1'), 'read', db.now, () => 0);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].created_at, '2026-10-21T00:00:00.000Z');
  });

  it('every route wallet mode opened counts anonymous callers', () => {
    for (const parts of [
      ['nfts', 'route.ts'],
      ['nfts', 'collections', 'route.ts'],
      ['nfts', 'collections', '[address]', 'route.ts'],
      ['nfts', 'collections', '[address]', 'items', 'route.ts'],
      ['nfts', 'collections', '[address]', 'activity', 'route.ts'],
      ['nfts', 'collections', '[address]', 'holders', 'route.ts'],
      ['nfts', 'collections', '[address]', 'traits', 'route.ts'],
      ['nfts', 'collections', '[address]', 'tokens', '[tokenId]', 'route.ts'],
      ['tokens', 'route.ts'],
      ['tokens', '[symbol]', 'route.ts'],
      ['tokens', '[symbol]', 'holders', 'route.ts'],
      ['swap', 'quote', 'route.ts'],
    ]) {
      const src = read('web', 'app', 'api', ...parts);
      const get = src.slice(src.indexOf('export async function GET'));
      assert.match(get, /const limited = await anonymousReadLimit\((accountId)?\);\r?\n\s+if \(limited\) return limited;/, parts.join('/'));
    }
    const helper = read('web', 'lib', 'readLimit.ts');
    assert.ok(helper.includes('if (id) return null;'));
    assert.ok(helper.includes("takeCallerAttempt(getSupabase(), headers(), 'read')"));
  });
});

describe('token reads for a wallet', () => {
  it('a token page and its holders open listed tokens only, without a session', () => {
    for (const parts of [
      ['web', 'app', 'api', 'tokens', '[symbol]', 'route.ts'],
      ['web', 'app', 'api', 'tokens', '[symbol]', 'holders', 'route.ts'],
    ]) {
      const src = read(...parts);
      assert.ok(src.includes('accountId ? await describeHeldToken(accountId, raw) : describeListedToken(raw)'), parts.join('/'));
    }
  });
});

describe('NFT reads for a wallet', () => {
  const API = read('web', 'lib', 'nftApi.ts');
  const fn = API.slice(API.indexOf('export async function routeViewer'), API.indexOf('export function walletForAccount'));

  it('a signed-in viewer is always their own Flizy wallet', () => {
    assert.ok(fn.indexOf('if (accountId) return') >= 0);
    assert.ok(fn.indexOf('if (accountId) return') < fn.indexOf("searchParams.get('viewer')"));
  });

  it('?viewer= is checked as an address and otherwise means nobody', () => {
    assert.ok(fn.includes('/^0x[0-9a-fA-F]{40}$/.test(raw) ? ethers.getAddress(raw) : ethers.ZeroAddress'));
  });
});
