/**
 * /api/mints routes: every one needs a session, writes refuse cross-origin
 * requests first, internal errors never reach the client, and the rules that
 * keep a mint safe are where they must be:
 *   - every on-chain action takes the gates in the marketplace's order
 *     (web/lib/mintExecute.ts) and always releases the lock;
 *   - only the creator manages a drop, and the chain must agree they own it;
 *   - a mint is simulated from the person's wallet before it is sent;
 *   - the mint mode, the new collection's address and the payout come from
 *     the chain or the session, never from the request;
 *   - allowlist proofs never leave the server.
 *
 * Route handlers need a Next runtime, so the rules are read from their
 * source, as test/nftMarketRoutes.test.js does.
 *
 * Run: node --test test/mintRoutes.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');
const API = ['app', 'api', 'mints'];

const ROUTES = {
  list: [...API, 'route.ts'],
  mine: [...API, 'mine', 'route.ts'],
  detect: [...API, 'detect', 'route.ts'],
  import: [...API, 'import', 'route.ts'],
  collections: [...API, 'collections', 'route.ts'],
  detail: [...API, '[collection]', 'route.ts'],
  action: [...API, '[collection]', '[action]', 'route.ts'],
  allowlist: [...API, '[collection]', 'allowlist', 'route.ts'],
};
const WRITES = ['import', 'collections', 'action', 'allowlist'];

function order(src, needles) {
  let last = -1;
  for (const n of needles) {
    const i = src.indexOf(n, last + 1);
    assert.ok(i > last, `out of order or missing: ${n}`);
    last = i;
  }
}

describe('every mint route', () => {
  for (const [name, parts] of Object.entries(ROUTES)) {
    it(`${name}: session required, internal errors only through apiErrorBody`, () => {
      const src = read(...parts);
      assert.match(src, /if \(!accountId\) return NextResponse\.json\(\{ error: 'Not logged in' \}, \{ status: 401 \}\)/);
      assert.match(src, /return clientErrorResponse\(err\) \?\? NextResponse\.json\(apiErrorBody\(\w+, err\), \{ status: 500 \}\);/);
      assert.doesNotMatch(src, /error: err\.message|err\.message\b.*NextResponse/);
    });
  }

  for (const name of WRITES) {
    it(`${name}: refuses cross-origin before reading the session`, () => {
      const src = read(...ROUTES[name]);
      for (const handler of ['export async function POST', 'export async function DELETE']) {
        const at = src.indexOf(handler);
        if (at === -1) continue;
        order(src.slice(at), ['rejectIfCrossOrigin(req)', 'getAccountIdFromCookie()']);
      }
    });
  }

  it('clientErrorResponse only passes person-written messages, else null', () => {
    const src = read('lib', 'mintRequest.ts');
    const fn = src.slice(src.indexOf('export function clientErrorResponse'));
    assert.match(fn, /err instanceof InputError/);
    assert.match(fn, /err instanceof MintError/);
    assert.match(fn, /err instanceof ClientError\) return NextResponse\.json\(\{ error: clientMessage\(err\) \}/);
    assert.match(fn, /return null;/);
  });
});

describe('on-chain actions take every gate, in order', () => {
  const src = read('lib', 'mintExecute.ts');
  it('rate limit, password, lock, daily limit, balance, log, send, outcome', () => {
    order(src, [
      'checkMarketRateLimit(supabase, accountId)',
      'requirePassword(supabase, accountId, args.password, tx.reason)',
      'tryAccountTxLock(supabase, accountId, MARKET_KIND)',
      'checkDailyNativeLimit(supabase, accountId, tx.value)',
      'assertCanPay(ctx.provider, viewer, tx.value, tx.calls.length)',
      ".from('transfers')",
      'runMarketCalls(',
      "status: 'confirmed'",
    ]);
  });

  it('marks a failed send and always releases the lock', () => {
    assert.match(src, /status: 'failed'/);
    assert.match(src, /finally \{\s*await releaseAccountTxLock\(supabase, accountId\);/);
  });

  it('every write route that sends uses runMintTx', () => {
    assert.match(read(...ROUTES.action), /runMintTx\(\{/);
    assert.match(read(...ROUTES.collections), /runMintTx\(\{/);
  });
});

describe('mint and creator actions', () => {
  const src = read(...ROUTES.action);

  it('only the creator manages a drop, and the chain must agree', () => {
    order(src, ['async function requireCreator', 'row.creator_account_id !== accountId', '.owner()', 'owner !== viewer.address']);
    order(src, ["if (action !== 'mint') await requireCreator(ctx, row, accountId, viewer);", 'await planMint(']);
  });

  it('a mint is simulated from the wallet before it is sent', () => {
    const plan = src.slice(src.indexOf('async function planMint'), src.indexOf('async function planConfigure'));
    assert.equal((plan.match(/simulateCall\(ctx\.provider, viewer\.address/g) || []).length, 2);
    assert.match(plan, /The mint price changed\. Review it again\./);
  });

  it('payout is the creator wallet, never typed', () => {
    assert.match(src, /payout: viewer\.address,/);
    assert.doesNotMatch(src, /field\(body, 'payout'\)/);
  });

  it('publishing writes nothing before the password check', () => {
    assert.doesNotMatch(src, /refreshAllowlistRoot/);
  });
});

describe('creating and bringing collections', () => {
  it('import: the contract owner only, mode from the chain', () => {
    const src = read(...ROUTES.import);
    order(src, ['detectExternal(ctx.provider, collection)', 'd.owner !== viewer.address', 'insertDrop(']);
    assert.doesNotMatch(src, /field\(body, 'mode'\)/);
  });

  it('create: the new address comes from the factory event, matched to this creator', () => {
    const src = read(...ROUTES.collections);
    order(src, ['runMintTx(', 'getTransactionReceipt(txHash)', "parsed?.name === 'CollectionCreated'", 'parsed.args.creator) === viewer.address', 'insertDrop(']);
    assert.doesNotMatch(src, /field\(body, 'collection'\)/);
  });
});

describe('one account cannot flood the Mint list', () => {
  it('import and create check the cap; create checks it before any gas is spent', () => {
    order(read(...ROUTES.import), ['creatorDropCount(accountId)) >= MAX_DROPS_PER_ACCOUNT', 'insertDrop(']);
    order(read(...ROUTES.collections), ['creatorDropCount(accountId)) >= MAX_DROPS_PER_ACCOUNT', 'runMintTx(']);
  });
});

describe('allowlist', () => {
  const src = read(...ROUTES.allowlist);
  it('creator only, Flizy-managed only, before any change', () => {
    order(src, ['row.creator_account_id !== accountId', "row.mode !== 'flizy'"]);
    for (const handler of ['export async function GET', 'export async function POST', 'export async function DELETE']) {
      const body = src.slice(src.indexOf(handler));
      order(body, ['creatorDrop(params.collection, accountId)', 'listAllowlist(']);
    }
  });

  it('the creator sees usernames, never the wallets behind them', () => {
    assert.ok(src.includes('entries: allowlistEntriesForCreator(rows)'));
    assert.ok(!src.includes('entries: rows'));
    assert.ok(src.includes("removeAllowlistRows(row.id, parseRemoveKeys(field(body, 'keys')))"));
  });

  it('proofs never leave the server', () => {
    assert.doesNotMatch(read(...ROUTES.detail), /proofFor|allowlistProof/);
    assert.doesNotMatch(src, /proofFor|allowlistProof/);
  });
});
