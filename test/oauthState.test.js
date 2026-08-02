/**
 * CSRF state for the OAuth round trip.
 *
 * Without this check an attacker hands a victim a callback URL carrying the
 * attacker's authorization code, and the victim's account ends up bound to the
 * attacker's GitHub, or the reverse. Since the bind decides where money can be
 * routed later, every one of these rejections is load-bearing.
 *
 * The session is not carried in the state payload. It is mixed into the HMAC
 * input, so a state minted under one session cannot verify under another, and
 * nothing session-derived travels through GitHub in a query string.
 *
 * Run: node --test test/oauthState.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const SECRET = 'test-oauth-state-secret-at-least-32-chars-long';
const SESSION_A = 'a'.repeat(64);
const SESSION_B = 'b'.repeat(64);

let state;
let savedSecret;

before(async () => {
  savedSecret = process.env.OAUTH_STATE_SECRET;
  process.env.OAUTH_STATE_SECRET = SECRET;
  state = await import('../web/lib/oauthState.ts');
});

after(() => {
  if (savedSecret === undefined) delete process.env.OAUTH_STATE_SECRET;
  else process.env.OAUTH_STATE_SECRET = savedSecret;
});

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build a state the same way the module does, so expiry can be controlled. */
function mintWithExpiry(sessionKey, expiryMs) {
  const payloadB64 = b64url(
    Buffer.from(JSON.stringify({ n: 'deadbeef', e: expiryMs }), 'utf8')
  );
  const sig = b64url(
    createHmac('sha256', SECRET).update(`${payloadB64}.${sessionKey}`).digest()
  );
  return `${payloadB64}.${sig}`;
}

describe('a state we issued', () => {
  it('verifies for the session it was minted under', () => {
    const value = state.createOAuthState(SESSION_A);
    assert.deepEqual(state.verifyOAuthState(value, SESSION_A), { ok: true });
  });

  it('is different every time, so one cannot be replayed as another', () => {
    const a = state.createOAuthState(SESSION_A);
    const b = state.createOAuthState(SESSION_A);
    assert.notEqual(a, b);
  });

  it('carries nothing session-derived in the payload', () => {
    const value = state.createOAuthState(SESSION_A);
    const [payloadB64] = value.split('.');
    const payload = Buffer.from(
      payloadB64.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    assert.ok(!payload.includes(SESSION_A), 'the session key must not travel to the provider');
    assert.deepEqual(Object.keys(JSON.parse(payload)).sort(), ['e', 'n']);
  });
});

describe('a state we did not issue', () => {
  it('rejects a state minted for a different session', () => {
    // The CSRF case: the attacker completes their own OAuth start, then feeds
    // the resulting callback URL to a logged-in victim.
    const value = state.createOAuthState(SESSION_A);
    const res = state.verifyOAuthState(value, SESSION_B);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_signature');
  });

  it('rejects a tampered payload', () => {
    const value = state.createOAuthState(SESSION_A);
    const [, sig] = value.split('.');
    const forged = b64url(Buffer.from(JSON.stringify({ n: 'x', e: Date.now() + 60000 }), 'utf8'));
    const res = state.verifyOAuthState(`${forged}.${sig}`, SESSION_A);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_signature');
  });

  it('rejects a tampered signature', () => {
    const value = state.createOAuthState(SESSION_A);
    const [payload] = value.split('.');
    const res = state.verifyOAuthState(`${payload}.notasignature`, SESSION_A);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad_signature');
  });

  it('rejects an expired state even when the signature is good', () => {
    const value = mintWithExpiry(SESSION_A, Date.now() - 1000);
    const res = state.verifyOAuthState(value, SESSION_A);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'expired');
  });

  it('accepts one that has not expired yet', () => {
    const value = mintWithExpiry(SESSION_A, Date.now() + 60000);
    assert.deepEqual(state.verifyOAuthState(value, SESSION_A), { ok: true });
  });

  it('rejects malformed and empty values', () => {
    for (const bad of ['', 'nodot', 'a.b.c', '.', 'x.']) {
      const res = state.verifyOAuthState(bad, SESSION_A);
      assert.equal(res.ok, false, `${JSON.stringify(bad)} should not verify`);
    }
  });

  it('rejects when there is no session at all', () => {
    const value = state.createOAuthState(SESSION_A);
    const res = state.verifyOAuthState(value, '');
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'malformed');
  });
});

describe('the signing secret', () => {
  it('refuses to sign without a dedicated secret', () => {
    const saved = process.env.OAUTH_STATE_SECRET;
    delete process.env.OAUTH_STATE_SECRET;
    try {
      assert.throws(() => state.createOAuthState(SESSION_A), /OAUTH_STATE_SECRET is required/);
    } finally {
      process.env.OAUTH_STATE_SECRET = saved;
    }
  });

  it('refuses a secret too short to be worth signing with', () => {
    const saved = process.env.OAUTH_STATE_SECRET;
    process.env.OAUTH_STATE_SECRET = 'short';
    try {
      assert.throws(() => state.createOAuthState(SESSION_A), /OAUTH_STATE_SECRET is required/);
    } finally {
      process.env.OAUTH_STATE_SECRET = saved;
    }
  });
});
