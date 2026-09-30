/**
 * A code the server hands back must be shown to the person waiting for it.
 *
 * On a development build there is no mail transport: sendMail logs the body and
 * reports success, and the verification helper returns the code as `devCode`
 * instead of sending it. Several routes pass it back, login included: a login
 * from an unrecognised browser asks for the emailed code on every runtime.
 *
 * A client that drops it leaves a login or signup that looks broken. You enter
 * the right password, the form asks for a six digit code, no email can arrive,
 * and nothing on the screen says the code was already handed over.
 *
 * So the rule is swept rather than remembered. Any client that calls a route
 * returning `devCode` must mention `devCode`.
 *
 * Run: node --test test/devCodeSurfaced.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');

/** Every .ts/.tsx under a directory. */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(path.join(__dirname, '..'), f).split(path.sep).join('/');

/** Routes that can return a devCode, as an API path like 'auth/login'. */
function routesReturningDevCode() {
  return walk(path.join(WEB, 'app', 'api'))
    .filter((f) => /route\.tsx?$/.test(f) && fs.readFileSync(f, 'utf8').includes('devCode'))
    .map((f) =>
      path
        .relative(path.join(WEB, 'app', 'api'), path.dirname(f))
        .split(path.sep)
        .join('/')
    );
}

describe('every dev code reaches the screen', () => {
  const routes = routesReturningDevCode();

  it('there are routes that return one, or this guard is watching nothing', () => {
    assert.ok(routes.length >= 3, `expected the known routes, found ${routes.length}`);
    for (const expected of ['auth/login', 'auth/email/send-code', 'account/emails']) {
      assert.ok(routes.includes(expected), `${expected} should still return a devCode`);
    }
  });

  for (const route of routesReturningDevCode()) {
    it(`every client of /api/${route} surfaces it`, () => {
      const clients = walk(path.join(WEB, 'app'))
        .concat(walk(path.join(WEB, 'components')))
        .filter((f) => !/\/api\//.test(rel(f)))
        .filter((f) => fs.readFileSync(f, 'utf8').includes(`/api/${route}`));

      assert.ok(clients.length > 0, `nothing calls /api/${route}; the guard would pass emptily`);

      const silent = clients.filter((f) => !fs.readFileSync(f, 'utf8').includes('devCode'));
      assert.deepEqual(
        silent.map(rel),
        [],
        `these call /api/${route} and never show the code it returns, so the screen asks for ` +
          'something the person has no way to obtain'
      );
    });
  }
});
