/**
 * Continue with Google signs in a verified Flizy account. It does not create
 * one, and the page cannot choose the email.
 *
 * Run: node --test test/googleLogin.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

describe('Google profile and the sign-in decision', () => {
  let oauth;
  let login;
  const env = {};

  before(async () => {
    for (const key of ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'NEXT_PUBLIC_SITE_URL', 'SITE_URL']) {
      env[key] = process.env[key];
    }
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-google-client';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-google-secret';
    process.env.SITE_URL = 'https://flizy.app';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://flizy.app';
    oauth = await import('../web/lib/googleOAuth.ts');
    login = await import('../web/lib/googleLogin.ts');
  });

  after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('asks Google for the email and keeps the secret on the server', () => {
    const url = new URL(oauth.googleAuthorizeUrl('state-value', 'challenge-value'));
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), 'test-google-client');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://flizy.app/api/auth/google/callback');
    assert.equal(url.searchParams.get('scope'), 'openid email');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'state-value');
    assert.equal(oauth.googleRedirectUri(), 'https://flizy.app/api/auth/google/callback');
    assert.doesNotMatch(url.toString(), /client_secret|test-google-secret/);
    process.env.SITE_URL = 'http://localhost:3000';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://flizy.app';
    assert.equal(oauth.googleRedirectUri(), 'http://localhost:3000/api/auth/google/callback');
    process.env.SITE_URL = 'https://flizy.app';
    process.env.NEXT_PUBLIC_SITE_URL = 'https://flizy.app';
  });

  it('accepts a verified email and refuses the rest', () => {
    assert.deepEqual(
      oauth.readGoogleProfile({ sub: '1234567890', email: 'Ada@Flizy.app', email_verified: true }),
      { sub: '1234567890', email: 'ada@flizy.app' }
    );
    assert.equal(oauth.readGoogleProfile({ sub: '1234567890', email: 'ada@flizy.app', email_verified: false }), null);
    assert.equal(oauth.readGoogleProfile({ sub: '1234567890', email: 'ada@flizy.app' }), null);
    assert.equal(oauth.readGoogleProfile({ sub: 'not-a-number', email: 'ada@flizy.app', email_verified: true }), null);
    assert.equal(oauth.readGoogleProfile({ sub: '1234567890', email: 'not an email', email_verified: true }), null);
  });

  it('signs in a verified account, including one that is paused', () => {
    assert.deepEqual(login.decideGoogleAccount({ id: ACCOUNT, email_verified_at: '2026-10-27T00:00:00Z' }), {
      action: 'signin',
      accountId: ACCOUNT,
      restore: false,
    });
    assert.equal(
      login.decideGoogleAccount({ id: ACCOUNT, email_verified_at: '2026-10-27T00:00:00Z', deactivated_at: '2026-10-01' }).restore,
      true
    );
    assert.equal(login.decideGoogleAccount(null).reason, 'no_account');
    assert.equal(login.decideGoogleAccount({ id: ACCOUNT, email_verified_at: null }).reason, 'unverified');
  });

  it('round-trips the cookie and drops a foreign next path', () => {
    const packed = login.packGoogleTicket({
      nonce: 'ab'.repeat(32),
      verifier: 'a'.repeat(43),
      next: 'https://evil.example/dashboard',
      back: 'signup',
    });
    const ticket = login.unpackGoogleTicket(packed);
    assert.equal(ticket.back, '/signup');
    assert.equal(ticket.next, '/dashboard');
    assert.equal(ticket.nonce, 'ab'.repeat(32));
    assert.equal(login.unpackGoogleTicket('not-a-ticket'), null);
  });

  it('stops after ten attempts in the window', () => {
    const key = `google-test-${Date.now()}`;
    for (let i = 0; i < 10; i += 1) assert.equal(login.allowGoogleAttempt(key, 1_700_000_000_000), true);
    assert.equal(login.allowGoogleAttempt(key, 1_700_000_000_000), false);
  });
});

describe('the Google routes and the button', () => {
  it('checks the signed state before it talks to Google', () => {
    const callback = read('web/app/api/auth/google/callback/route.ts');
    const start = read('web/app/api/auth/google/start/route.ts');
    const cap = callback.indexOf('state.length > 2000');
    const state = callback.indexOf('verifyOAuthState(');
    const exchange = callback.indexOf('exchangeGoogleCode(');
    assert.ok(cap > 0 && state > cap && exchange > state);
    assert.doesNotMatch(callback, /searchParams\.get\('email'\)/);
    assert.match(callback, /createSession\(decision\.accountId, res\)/);
    assert.match(start, /packGoogleTicket/);
    assert.doesNotMatch(start, /client_secret/);
    assert.match(start, /googleAuthOrigin/);
    assert.match(callback, /googleAuthOrigin/);
    assert.doesNotMatch(start, /siteOrigin/);
    assert.doesNotMatch(callback, /siteOrigin/);
    assert.doesNotMatch(read('web/app/login/LoginForm.tsx'), /googleOAuth|GOOGLE_OAUTH/);
  });

  it('the login button starts Google and a passkey still says coming soon', () => {
    const login = read('web/app/login/LoginForm.tsx');
    assert.match(login, /\/api\/auth\/google\/start/);
    assert.doesNotMatch(login, /showSoon\('Continue with Google'\)/);
    assert.match(login, /showSoon\('Continue with a passkey'\)/);
    const signup = read('web/app/signup/SignupForm.tsx');
    assert.match(signup, /\/api\/auth\/google\/start/);
    assert.doesNotMatch(signup, /showSoon\('Continue with Google'\)/);
  });
});
