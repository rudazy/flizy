/**
 * Google sign-in replaces the password, not the emailed login code.
 *
 * Covers: the signed note a Google sign-in leaves while it waits for its code
 * (web/lib/googleLogin.ts) holds, and refuses anything altered, unsigned, old
 * or malformed; the callback asks for the code on a browser Flizy does not
 * remember and opens a session only on one it does; a paused account comes
 * back only once the sign-in is complete; the verify route takes the account
 * from the note, never the body, and opens the session only after the code;
 * the login form's code-only step.
 *
 * Run: node --test test/googleCode.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SECRET = 'x'.repeat(40);
const ID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

let G;
before(async () => {
  G = await import('../web/lib/googleLogin.ts');
});

const note = (over = {}) => ({ accountId: ID, email: 'ada@example.com', restore: false, next: '/dashboard', issuedAt: NOW, ...over });

describe('the note a Google sign-in leaves while it waits for its code', () => {
  it('reads back what it was given', () => {
    const raw = G.packGooglePending(note({ restore: true, next: '/claim/abc' }), SECRET);
    assert.deepEqual(G.unpackGooglePending(raw, SECRET, NOW + 60_000), note({ restore: true, next: '/claim/abc' }));
  });

  it('is refused when altered, signed with another secret, or unsigned', () => {
    const raw = G.packGooglePending(note(), SECRET);
    const [body, sig] = raw.split('.');
    const other = Buffer.from(JSON.stringify(note({ accountId: '22222222-2222-4222-8222-222222222222' }))).toString('base64url');
    assert.equal(G.unpackGooglePending(`${other}.${sig}`, SECRET, NOW), null, 'another account under the same signature');
    assert.equal(G.unpackGooglePending(raw, 'y'.repeat(40), NOW), null);
    assert.equal(G.unpackGooglePending(body, SECRET, NOW), null);
    assert.equal(G.unpackGooglePending(`${body}.`, SECRET, NOW), null);
    assert.equal(G.unpackGooglePending('', SECRET, NOW), null);
  });

  it('lasts as long as the code (15 minutes), and never comes from the future', () => {
    const raw = G.packGooglePending(note(), SECRET);
    assert.ok(G.unpackGooglePending(raw, SECRET, NOW + 15 * 60_000));
    assert.equal(G.unpackGooglePending(raw, SECRET, NOW + 15 * 60_000 + 1), null);
    assert.equal(G.unpackGooglePending(G.packGooglePending(note({ issuedAt: NOW + 5 * 60_000 }), SECRET), SECRET, NOW), null);
  });

  it('needs a real secret, a real account id, and a safe next page', () => {
    assert.equal(G.packGooglePending(note(), 'short'), '');
    assert.equal(G.unpackGooglePending(G.packGooglePending(note(), SECRET), 'short', NOW), null);
    assert.equal(G.unpackGooglePending(G.packGooglePending(note({ accountId: 'not-a-uuid' }), SECRET), SECRET, NOW), null);
    assert.equal(G.unpackGooglePending(G.packGooglePending(note({ next: 'https://evil.example/' }), SECRET), SECRET, NOW).next, '/dashboard');
  });
});

describe('the callback', () => {
  const src = read('web/app/api/auth/google/callback/route.ts');

  it('asks for the code on a browser Flizy does not remember, before any session or restore', () => {
    const trusted = src.indexOf('if (!(await hasTrustedLoginDevice(decision.accountId))) {');
    assert.ok(trusted > 0);
    assert.match(src.slice(trusted, trusted + 200), /return askForCode\(ticket, decision\.accountId, profile\.email, decision\.restore\);/);
    assert.ok(src.indexOf('restoreAccount(decision.accountId, ROUTE)') > trusted, 'a paused account is not restored before the code');
    assert.ok(src.indexOf('createSession(decision.accountId, res)') > trusted);
  });

  it('sends the login code and leaves the signed note; the code itself goes in the address only on a development build', () => {
    const ask = src.slice(src.indexOf('async function askForCode'), src.indexOf('async function findAccount'));
    assert.match(ask, /issueEmailVerificationCode\(\{ accountId, email, purpose: 'login' \}\)/);
    assert.match(ask, /packGooglePending\(\{ accountId, email, restore, next: ticket\.next, issuedAt: Date\.now\(\) \}, process\.env\.OAUTH_STATE_SECRET \|\| ''\)/);
    assert.match(ask, /url\.searchParams\.set\('google', 'code'\)/);
    assert.match(ask, /if \(issued\.devCode\) url\.searchParams\.set\('dev', issued\.devCode\);/);
    assert.match(ask, /res\.cookies\.set\(GOOGLE_PENDING_COOKIE, note, \{ \.\.\.cookieBase\(\), maxAge: /);
    assert.match(src, /function cookieBase\(\) \{\s+return \{\s+httpOnly: true,/);
  });
});

describe('the code step', () => {
  const src = read('web/app/api/auth/google/verify/route.ts');

  it('checks the origin and the rate limit, then reads the account from the note, never the body', () => {
    const origin = src.indexOf('rejectIfCrossOrigin(req)');
    const limit = src.indexOf('allowGoogleAttempt(');
    const pending = src.indexOf('unpackGooglePending(');
    assert.ok(origin > 0 && limit > origin && pending > limit);
    assert.doesNotMatch(src, /body\??\.(accountId|email|account)/);
  });

  it('opens the session only after the code, restores a paused account only then, and clears the note', () => {
    const consume = src.indexOf('consumeEmailVerificationCode(');
    const restore = src.indexOf('restoreAccount(pending.accountId, ROUTE)');
    const session = src.indexOf('createSession(pending.accountId, res)');
    assert.ok(consume > 0 && restore > consume && session > restore);
    assert.match(src.slice(consume, restore), /if \(!consumed\.ok\) \{\s+return NextResponse\.json/);
    assert.match(src, /return clearNote\(res\);/);
    assert.match(src, /purpose: 'login', code \}\)/);
  });

  it('a resend issues a new login code for the same account', () => {
    assert.match(src, /if \(body\?\.resend === true\) \{\s+const issued = await issueEmailVerificationCode\(\{ accountId: pending\.accountId, email: pending\.email, purpose: 'login' \}\);/);
  });
});

describe('the login form', () => {
  const form = read('web/app/login/LoginForm.tsx');

  it('opens on the code step after Google, without the email or password', () => {
    assert.match(form, /if \(params\.get\('google'\) === 'code'\) \{\s+setGoogleCode\(true\);\s+setNeedsCode\(true\);/);
    assert.match(form, /\{googleCode \? null : \(/);
    assert.match(form, /fetch\('\/api\/auth\/google\/verify', \{[\s\S]{0,140}body: JSON\.stringify\(\{ code \}\)/);
    assert.match(form, /router\.push\(safeNext\(data\.next\)\)/);
    assert.match(form, /googleCode \? '\/api\/auth\/google\/verify' : '\/api\/auth\/login'/);
  });
});
