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

describe('routes that move money or grant authority take the password', () => {
  /**
   * Each of these changes who controls the account or moves value out of it,
   * so a stolen session cookie alone must not be enough. runMintTx calls
   * requirePassword (web/lib/mintExecute.ts).
   */
  const PASSWORD_ROUTES = [
    'account/closure',
    'account/password',
    'account/username',
    'identity',
    'limits',
    'link/create',
    'market/[action]',
    'mints/[collection]/[action]',
    'mints/collections',
    'mints/generated/pay',
    'pay/execute',
    'pay/save',
    'pin',
    'swap/execute',
    'swap/limit',
    'swap/liquidity',
    'trusted',
  ];
  const PASSWORD_CHECK = /requirePassword\(|runMintTx\(/;

  it('each listed route exists', () => {
    const routes = new Set(routeFiles().map(rel));
    assert.deepEqual(PASSWORD_ROUTES.filter((r) => !routes.has(r)), []);
  });

  it('each listed route verifies the password server side', () => {
    const missing = PASSWORD_ROUTES.filter(
      (r) => !PASSWORD_CHECK.test(read(path.join(API_DIR, r, 'route.ts')))
    );
    assert.deepEqual(missing, []);
  });

  it('runMintTx really does call requirePassword', () => {
    assert.match(read(path.join(ROOT, 'web', 'lib', 'mintExecute.ts')), /requirePassword\(/);
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
