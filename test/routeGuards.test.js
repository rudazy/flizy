/**
 * Static guards over every web route handler, in the style of apiErrorLeak.
 *
 * Each rule here was broken by a real route before it was written down, and
 * each is easy to break again by adding one file. A new route has to meet them
 * or this test names it.
 *
 * Run: node --test test/routeGuards.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'web', 'app', 'api');

function routeFiles(dir = API_DIR, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) routeFiles(full, found);
    else if (entry.name === 'route.ts') found.push(full);
  }
  return found;
}

const rel = (file) => path.relative(API_DIR, path.dirname(file)).replace(/\\/g, '/');
const read = (file) => fs.readFileSync(file, 'utf8');

/** Exported handlers that change state. */
const MUTATING = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/;

describe('every state-changing route checks the request Origin', () => {
  /**
   * Routes that may skip the check, each with the reason. A helper that runs
   * the check itself counts as the check.
   */
  const ORIGIN_EXEMPT = {
    withdraw: 'disabled: every method answers a fixed 403 and reads nothing',
    'internal/security-mail': 'server to server: no cookie, a bearer secret instead (checked below)',
    'internal/payment-notice': 'server to server: no cookie, a bearer secret instead (checked below)',
  };
  const ORIGIN_CHECK = /rejectIfCrossOrigin\(|generationCaller\(/;

  it('finds the routes to check', () => {
    assert.ok(routeFiles().filter((f) => MUTATING.test(read(f))).length >= 40);
  });

  it('calls rejectIfCrossOrigin (directly or through a helper that does)', () => {
    const missing = routeFiles()
      .filter((f) => MUTATING.test(read(f)))
      .filter((f) => !ORIGIN_EXEMPT[rel(f)] && !ORIGIN_CHECK.test(read(f)))
      .map(rel);
    assert.deepEqual(missing, []);
  });
});

describe('server-to-server routes take a bearer secret', () => {
  it('every route under api/internal checks one before anything else', () => {
    const internal = routeFiles().filter((f) => rel(f).startsWith('internal/'));
    assert.ok(internal.length >= 1);
    for (const file of internal) {
      const src = read(file);
      const handler = src.search(MUTATING);
      const check = src.indexOf('bearerMatches(', handler);
      assert.ok(handler > 0 && check > handler, rel(file));
      assert.ok(src.indexOf('req.json()') > check, `${rel(file)} reads the body before the secret`);
    }
  });
});

describe('the tiers hold: account changes take the password, money takes the PIN', () => {
  /**
   * Tier 2. Each of these changes who controls the account or what protects
   * it, so they take the account password (requirePassword) and never only
   * the PIN.
   */
  const PASSWORD_ROUTES = [
    'account/closure',
    'account/password',
    'account/username',
    'custody/passkey',
    'identity',
    'limits',
    'link/create',
    'pay/save',
    'pin',
    'trusted',
  ];

  /**
   * Tier 1. Each of these moves value or signs a transaction from the wallet,
   * so a stolen session cookie alone must not be enough. They take the PIN
   * (requireStepUp, web/lib/stepUp.ts; runMintTx calls it), and never the
   * password: the password is for account changes, and typing it for every
   * payment is what the tiers replace.
   */
  const STEP_UP_ROUTES = [
    'market/[action]',
    'mints/[collection]/[action]',
    'mints/collections',
    'mints/generated/pay',
    'pay/execute',
    'pay/swap',
    'swap/limit',
  ];

  /**
   * Tier 0 is possible only here: a small ETH payment to a known recipient
   * (web/lib/tiers.ts). These call requireApproval with a tier worked out on
   * the server; every other money route calls requireStepUp and takes the PIN
   * every time.
   */
  const TIERED_ROUTES = ['pay/execute'];

  /**
   * Trades whose output lands back in the caller's own wallet: on testnet they
   * take no PIN. This list is the only place such a route may live, so a new
   * money route cannot skip the PIN by accident.
   */
  const NO_PIN_TRADE_ROUTES = ['swap/execute', 'swap/liquidity'];

  const PASSWORD_CHECK = /requirePassword\(/;
  const STEP_UP_CHECK = /requireStepUp\(|requireApproval\(|runMintTx\(/;
  const src = (r) => read(path.join(API_DIR, r, 'route.ts'));

  it('each listed route exists, and no route is on both lists', () => {
    const routes = new Set(routeFiles().map(rel));
    assert.deepEqual([...PASSWORD_ROUTES, ...STEP_UP_ROUTES].filter((r) => !routes.has(r)), []);
    assert.deepEqual(PASSWORD_ROUTES.filter((r) => STEP_UP_ROUTES.includes(r)), []);
  });

  it('account changes verify the password server side, not the PIN', () => {
    assert.deepEqual(PASSWORD_ROUTES.filter((r) => !PASSWORD_CHECK.test(src(r))), []);
    assert.deepEqual(PASSWORD_ROUTES.filter((r) => STEP_UP_CHECK.test(src(r))), []);
  });

  it('money routes verify the PIN server side, not the password', () => {
    assert.deepEqual(STEP_UP_ROUTES.filter((r) => !STEP_UP_CHECK.test(src(r))), []);
    assert.deepEqual(STEP_UP_ROUTES.filter((r) => PASSWORD_CHECK.test(src(r))), []);
  });

  it('every route that takes either is on a list, so a new one has to pick its tier', () => {
    const unlisted = routeFiles()
      .filter((f) => PASSWORD_CHECK.test(read(f)) || STEP_UP_CHECK.test(read(f)))
      .map(rel)
      .filter((r) => !PASSWORD_ROUTES.includes(r) && !STEP_UP_ROUTES.includes(r));
    assert.deepEqual(unlisted, []);
  });

  it('runMintTx really does call requireStepUp, and not requirePassword', () => {
    const mint = read(path.join(ROOT, 'web', 'lib', 'mintExecute.ts'));
    assert.match(mint, /requireStepUp\(/);
    assert.doesNotMatch(mint, /requirePassword\(/);
  });

  it('only the tiered routes may skip the PIN, and they are money routes', () => {
    assert.deepEqual(TIERED_ROUTES.filter((r) => !STEP_UP_ROUTES.includes(r)), []);
    const skipping = routeFiles()
      .filter((f) => /requireApproval\(/.test(read(f)))
      .map(rel);
    assert.deepEqual(skipping.sort(), [...TIERED_ROUTES].sort());
    for (const r of STEP_UP_ROUTES.filter((x) => !TIERED_ROUTES.includes(x))) {
      assert.doesNotMatch(src(r), /requireApproval\(|evaluateTier\(|sendTier\(|swapTier\(/, r);
    }
  });

  it('a tiered route works the tier out itself, from what it will send', () => {
    for (const r of TIERED_ROUTES) {
      const s = src(r);
      assert.match(s, /const tier = await sendTier\(supabase, payerId, /, r);
      assert.match(s, /requireApproval\([\s\S]{0,200}?,\s*tier\s*\)/, r);
      assert.doesNotMatch(s, /body\.tier|body\.known|body\.quick/, r);
    }
  });

  it('a no-PIN trade route pays nobody and keeps the session, same-origin and lock gates', () => {
    for (const r of NO_PIN_TRADE_ROUTES) {
      const s = src(r);
      assert.doesNotMatch(s, /requireStepUp\(|requireApproval\(|requirePassword\(|body\.pin/, r);
      assert.match(s, /const denied = rejectIfCrossOrigin\(req\);/, r);
      assert.match(s, /const accountId = await getAccountIdFromCookie\(\);/, r);
      assert.match(s, /await tryAccountTxLock\(supabase, accountId, /, r);
      // The output goes to the caller's own wallet, never to an address from the body.
      assert.doesNotMatch(s, /body\.(to|recipient|address)\b/, r);
    }
  });

  it('requireApproval skips the PIN for Tier 0 only', () => {
    const stepUp = read(path.join(ROOT, 'web', 'lib', 'stepUp.ts'));
    assert.match(stepUp, /if \(tier\.tier === 0\) return \{ ok: true \};\s*return requireStepUp\(supabase, accountId, pin, action\);/);
  });

  it('the step-up reads the PIN from the body, never the password', () => {
    for (const r of STEP_UP_ROUTES.filter((x) => /requireStepUp\(|requireApproval\(/.test(src(x)))) {
      assert.doesNotMatch(src(r), /body\.password|field\(body, 'password'\)/, r);
    }
  });
});

describe('a chat link code leaves the server only from link/create', () => {
  it('GET /api/dashboard does not read link codes', () => {
    assert.doesNotMatch(read(path.join(API_DIR, 'dashboard', 'route.ts')), /link_codes/);
  });

  it('link/create is the only route that reads or writes them', () => {
    const touching = routeFiles()
      .filter((f) => /link_codes|createLinkCode\(/.test(read(f)))
      .map(rel);
    assert.deepEqual(touching, ['link/create']);
  });
});

describe('history hands the browser only rendered transfer fields', () => {
  it('projects transfer rows through publicTransferRow', () => {
    assert.match(read(path.join(API_DIR, 'history', 'route.ts')), /publicTransferRow\(e\.row\)/);
  });
});
