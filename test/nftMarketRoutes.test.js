/**
 * NFT routes: every one needs a session, and the trading route checks in the
 * right order (origin, session, chain checks, password, daily limit, balance,
 * lock, log, send) and always releases the lock.
 *
 * Route handlers need a Next runtime, so the order is read from their source,
 * the same way test/pinRouteGate.test.js does. The rate limit runs for real
 * against a fake Supabase client.
 *
 * Run: node --test test/nftMarketRoutes.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API = path.join(__dirname, '..', 'web', 'app', 'api');
const read = (...p) => fs.readFileSync(path.join(API, ...p), 'utf8');
const MARKET = read('market', '[action]', 'route.ts');

const READ_ROUTES = [
  ['nfts', 'collections', 'route.ts'],
  ['nfts', 'collections', '[address]', 'route.ts'],
  ['nfts', 'collections', '[address]', 'items', 'route.ts'],
  ['nfts', 'collections', '[address]', 'activity', 'route.ts'],
  ['nfts', 'collections', '[address]', 'holders', 'route.ts'],
  ['nfts', 'collections', '[address]', 'traits', 'route.ts'],
  ['nfts', 'collections', '[address]', 'tokens', '[tokenId]', 'route.ts'],
  ['nfts', 'mine', 'route.ts'],
];

describe('read routes', () => {
  for (const parts of READ_ROUTES) {
    it(`${parts.join('/')} requires a session and hides internal errors`, () => {
      const src = read(...parts);
      assert.match(src, /if \(!accountId\) return NextResponse\.json\(\{ error: 'Not logged in' \}, \{ status: 401 \}\)/);
      assert.match(src, /apiErrorBody\(ROUTE, err\)/);
      assert.doesNotMatch(src, /err\.message/);
    });
  }

  it('cursors from the browser are validated before use', () => {
    for (const parts of READ_ROUTES.filter((p) => !p.includes('traits') && !p.includes('[tokenId]') && p[p.length - 2] !== '[address]')) {
      assert.match(read(...parts), /checkCursor\(rawCursor\)/, parts.join('/'));
    }
  });
});

describe('trading route order', () => {
  const at = (needle) => {
    const i = MARKET.indexOf(needle);
    assert.ok(i >= 0, `missing: ${needle}`);
    return i;
  };
  const post = MARKET.slice(MARKET.indexOf('export async function POST'));
  const inPost = (needle) => {
    const i = post.indexOf(needle);
    assert.ok(i >= 0, `missing in POST: ${needle}`);
    return i;
  };

  it('rejects cross-origin first, then needs a session', () => {
    assert.ok(inPost('rejectIfCrossOrigin(req)') < inPost('getAccountIdFromCookie()'));
    assert.ok(inPost('getAccountIdFromCookie()') < inPost('buildPlan('));
  });

  it('is off until a marketplace is configured', () => {
    assert.match(post, /if \(!ctx\.market\) return NextResponse\.json\(\{ error: 'Trading is not live yet\.' \}, \{ status: 503 \}\)/);
  });

  it('checks the plan on chain and the password, then locks, then the daily limit and balance, then sends', () => {
    // The daily limit is read under the lock, so two parallel buys cannot both
    // pass it before either one's transfers row exists.
    const order = [
      'checkMarketRateLimit(',
      'buildPlan(',
      'requirePassword(',
      'tryAccountTxLock(',
      'checkDailyNativeLimit(',
      'assertCanPay(',
      ".from('transfers')",
      'runMarketCalls(',
    ].map(inPost);
    for (let i = 1; i < order.length; i += 1) assert.ok(order[i - 1] < order[i], `step ${i} out of order`);
  });

  it('applies the daily limit to anything that sends ETH', () => {
    assert.match(post, /if \(plan\.value > 0n\) \{\s*const daily = await checkDailyNativeLimit\(supabase, accountId, plan\.value\);/);
  });

  it('always releases the lock and marks a failed send', () => {
    assert.match(post, /\} finally \{\s*await releaseAccountTxLock\(supabase, accountId\);/);
    assert.match(post, /status: 'failed'/);
  });

  it('only exits work while paused', () => {
    assert.match(post, /const exits = action === 'cancel' \|\| action === 'offer-cancel' \|\| action === 'withdraw';/);
  });

  it('a buy and an accept bind to the amount the person reviewed', () => {
    assert.ok(at("if (BigInt(listing.price) !== reviewed) throw new MarketError('The price changed. Review it again.', 409);") > 0);
    assert.ok(at("if (BigInt(offer.amount) !== reviewed) throw new MarketError('The offer changed. Review it again.', 409);") > 0);
    assert.match(MARKET, /call\('buy', \[collection, tokenId, reviewed\], reviewed\)/);
  });

  it('ownership is read from the chain before listing, accepting or setting royalty', () => {
    assert.match(MARKET, /if \(!owner \|\| ethers\.getAddress\(owner\) !== viewer\) throw new MarketError\('You do not own this NFT\.', 403\);/);
    assert.match(MARKET, /Only the collection contract's owner can set its royalty\./);
  });

  it('unverified collections say so in the password prompt', () => {
    assert.match(MARKET, /an NFT Flizy has not verified/);
  });

  it('only messages written for the person reach the client', () => {
    assert.ok(post.includes('{ error: clientMessage(err) }, { status: err instanceof MarketError ? err.status : 400 }'));
    assert.match(post, /return NextResponse\.json\(apiErrorBody\(route, err\), \{ status: 500 \}\);/);
  });
});

describe('checkMarketRateLimit', () => {
  let limit;
  before(async () => {
    limit = await import('../web/lib/marketRateLimit.ts');
  });

  function fakeSupabase(rows, error = null) {
    const seen = {};
    const chain = {
      select: () => chain,
      eq: (k, v) => {
        seen[k] = v;
        return chain;
      },
      gte: async () => ({ data: rows, error }),
    };
    return { seen, client: { from: (t) => ((seen.table = t), chain) } };
  }

  it('counts nft_market rows for this account in the last hour', async () => {
    const { seen, client } = fakeSupabase([]);
    const out = await limit.checkMarketRateLimit(client, 'acct-1', Date.parse('2026-10-02T10:00:00Z'));
    assert.deepEqual(out, { ok: true });
    assert.equal(seen.table, 'transfers');
    assert.equal(seen.account_id, 'acct-1');
    assert.equal(seen.kind, 'nft_market');
  });

  it('refuses at the cap with a wait time', async () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    const rows = Array.from({ length: 30 }, (_, i) => ({ created_at: new Date(now - 50 * 60 * 1000 + i).toISOString() }));
    const out = await limit.checkMarketRateLimit(fakeSupabase(rows).client, 'acct-1', now);
    assert.equal(out.ok, false);
    assert.equal(out.status, 429);
    assert.match(out.error, /30 marketplace actions in an hour/);
  });

  it('closes when the counter cannot be read', async () => {
    const out = await limit.checkMarketRateLimit(fakeSupabase(null, { message: 'down' }).client, 'acct-1');
    assert.equal(out.ok, false);
    assert.equal(out.status, 503);
  });
});

describe('on-chain listing checks are bounded', () => {
  const API_LIB = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'nftApi.ts'), 'utf8');

  it('checks nothing without a scope, and at most 300 listings with one', () => {
    assert.match(API_LIB, /: scope \?\? \(\(\) => false\);/);
    assert.match(API_LIB, /const MAX_VALIDATE = 300;/);
    assert.match(API_LIB, /\.slice\(0, MAX_VALIDATE\);/);
  });

  it('the wallet and collection list scope their checks', () => {
    assert.match(read('nfts', 'mine', 'route.ts'), /marketView\(ctx, \(l\) => l\.seller === viewer\.address && held\.has/);
    assert.match(read('nfts', 'collections', 'route.ts'), /marketView\(ctx, \(l\) => shown\.has\(l\.collection\)\)/);
  });

  it('metadata links show only for verified collections', () => {
    assert.match(read('nfts', 'collections', '[address]', 'tokens', '[tokenId]', 'route.ts'), /externalUrl: header\.verified \? item\.externalUrl : null/);
  });
});

describe('approval and royalty bounds', () => {
  it('approves the marketplace for the one token, never the whole collection', () => {
    assert.match(MARKET, /encodeFunctionData\('approve', \[market, tokenId\]\)/);
    assert.ok(!MARKET.includes("encodeFunctionData('setApprovalForAll'"));
  });

  it('accepting an offer passes the royalty rate the seller reviewed', () => {
    assert.match(MARKET, /call\('acceptOffer', \[offerId, tokenId, reviewed, maxRoyaltyBps\]\)/);
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'components', 'NftTradeSheet.tsx'), 'utf8'), /maxRoyaltyBps: Number\(capped\)/);
  });
});

describe('zero-value marketplace rows', () => {
  const MIGRATION = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'migrations', '20261002130000_transfers_nft_market_zero.sql'),
    'utf8'
  );

  it('the migration allows amount 0 only for nft_market rows', () => {
    assert.match(MIGRATION, /check \(amount_eth > 0 or \(kind = 'nft_market' and amount_eth = 0\)\)/);
    assert.match(MIGRATION, /raise exception/);
  });

  it('every zero-amount marketplace row the code writes is kind nft_market', () => {
    assert.match(MARKET, /amount_eth: ethers\.formatEther\(plan\.value\),[\s\S]{0,200}kind: MARKET_KIND,/);
    const engine = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine', 'executeAcceptOffer.js'), 'utf8');
    assert.match(engine, /amount_eth: '0',[\s\S]{0,120}kind: 'nft_market',/);
  });

  it('a row that cannot be written reports the database reason to the server log', () => {
    assert.match(MARKET, /could not log marketplace action: \$\{logError\?\.message/);
  });
});
