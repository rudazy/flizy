/**
 * Account pause: the two copies of the predicate, and the gates that have
 * to stay in front of a burn, a spend, or a password-free deactivate.
 *
 * Run: node --test test/accountClosure.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { closureOf, isMissingClosureColumn } = require('../lib/accountClosure');

const ROWS = [
  null,
  undefined,
  {},
  { deleted_at: null, deactivated_at: null },
  { deactivated_at: '2026-10-06T00:00:00.000Z' },
  { deleted_at: '2026-10-06T00:00:00.000Z' },
  {
    deleted_at: '2026-10-06T00:00:00.000Z',
    deactivated_at: '2026-10-06T00:00:00.000Z',
  },
];

const ERRORS = [
  null,
  undefined,
  { code: '42703', message: 'column accounts.deleted_at does not exist' },
  { code: 'PGRST204', message: 'schema cache' },
  { message: 'Could not find the deactivated_at column' },
  { code: '23505', message: 'duplicate key' },
];

describe('account closure predicate', () => {
  let web;

  before(async () => {
    web = await import('../web/lib/accountClosure.ts');
  });

  it('keeps a past delete closed until sign-in, ahead of a pause', () => {
    assert.equal(closureOf(null), 'open');
    assert.equal(closureOf({}), 'open');
    assert.equal(closureOf({ deactivated_at: 'x' }), 'deactivated');
    assert.equal(closureOf({ deleted_at: 'x', deactivated_at: 'x' }), 'deleted');
  });

  it('matches the web copy on every row and every error', () => {
    for (const row of ROWS) {
      assert.equal(web.closureOf(row), closureOf(row));
    }
    for (const error of ERRORS) {
      assert.equal(web.isMissingClosureColumn(error), isMissingClosureColumn(error));
    }
    assert.equal(isMissingClosureColumn({ code: '23505', message: 'duplicate key' }), false);
  });
});

describe('closure stays behind the password and ahead of the burn', () => {
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('pauses the account and does not write a delete', () => {
    const route = read('web/app/api/account/closure/route.ts');
    assert.match(route, /rejectIfCrossOrigin/);
    assert.match(route, /getAccountIdFromCookie/);
    // A pause signs every session out, so a cookie alone must not do it.
    const passwordAt = route.indexOf("requirePassword(supabase, accountId, password, 'pause your account')");
    assert.ok(passwordAt !== -1 && passwordAt < route.indexOf('deactivated_at: now'));
    assert.ok(route.indexOf('password.length > 256') < passwordAt);
    assert.doesNotMatch(route, /deleted_at: now/);
    assert.doesNotMatch(route, /console\.(log|debug|info|warn)\([^)]*password/);
    assert.match(route, /deactivated_at: now/);
    assert.match(route, /body\.action !== 'deactivate'/);
    const pauseAt = route.indexOf('deactivated_at: now');
    const pauseRowAt = route.indexOf('if (!paused)');
    assert.ok(pauseAt !== -1 && pauseRowAt > pauseAt);
  });

  it('restores a paused or previously closed account after the password matches', () => {
    const login = read('web/app/api/auth/login/route.ts');
    const matchAt = login.indexOf("error: 'Invalid credentials'");
    const codeAt = login.indexOf('needsCode: true');
    const sessionAt = login.indexOf('await createSession(');
    const revokeAt = login.indexOf('await revokeAllSessions(data.id)');
    const restoreAt = login.indexOf('deactivated_at: null, deleted_at: null');
    assert.doesNotMatch(login, /ACCOUNT_DELETED/);
    assert.doesNotMatch(login, /cannot be restored/);
    assert.ok(matchAt !== -1 && codeAt > matchAt);
    assert.ok(revokeAt > codeAt && restoreAt > revokeAt && sessionAt > restoreAt);
  });

  it('does not burn a link code for a closed account', () => {
    const identity = read('lib/identity.js');
    const closedAt = identity.indexOf("reason: 'closed'");
    const burnAt = identity.indexOf('Burn the code BEFORE binding');
    assert.ok(closedAt !== -1 && burnAt !== -1 && closedAt < burnAt);
  });

  it('refuses chat for both states before lock and unlock', () => {
    const router = read('lib/router.js');
    const replyAt = router.indexOf('const closedChat = closureReply(account)');
    const lockAt = router.indexOf('parseLockCommand(text)');
    assert.ok(replyAt !== -1 && lockAt !== -1 && replyAt < lockAt);
    assert.doesNotMatch(router, /Chat can no longer use it/);
    assert.match(
      router,
      /This Flizy account is paused\. Sign in on the Flizy site with your account password to restore it\./
    );
    assert.match(
      router,
      /That Flizy account is paused\. Sign in on the Flizy site with the account password, then link again\./
    );
  });

  it('rejects a session whose account row is gone', () => {
    const cookies = read('web/lib/cookies.ts');
    const warnAt = cookies.indexOf('warnMissingClosureOnce()');
    const missingAt = cookies.indexOf('if (!account) return null');
    assert.ok(warnAt !== -1 && missingAt > warnAt);
    assert.match(cookies.slice(missingAt), /if \(state === 'deleted' \|\| state === 'deactivated'\) return null/);
  });
});
