/**
 * The three guards on POST /api/auth/signup.
 *
 * That route was the only unauthenticated one that both wrote a row and mailed
 * an address the caller chose, with nothing in front of it: no address check
 * beyond "not empty", no cap, no bot filter. So it could be driven to deliver
 * Flizy verification codes to arbitrary mailboxes.
 *
 * The route handler cannot be imported here (it builds a NextResponse and reads
 * request headers), so the guards it delegates to are tested directly, the same
 * way pinRouteGate.test.js tests the gate rather than /api/pin. The last block
 * closes that gap from the other side: it reads the route's source and proves
 * all three are actually wired, and wired in the order that keeps a malformed
 * request out of the database.
 *
 * Run: node --test test/signupGuards.test.js
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let limit;
let honeypot;
let savedMax;

before(async () => {
  limit = await import('../web/lib/signupLimit.ts');
  honeypot = await import('../web/lib/honeypot.ts');
  savedMax = process.env.SIGNUP_MAX_PER_HOUR;
});

beforeEach(() => {
  delete process.env.SIGNUP_MAX_PER_HOUR;
});

after(() => {
  if (savedMax === undefined) delete process.env.SIGNUP_MAX_PER_HOUR;
  else process.env.SIGNUP_MAX_PER_HOUR = savedMax;
});

/**
 * Minimal stand-in for the one call this module makes. The fake in
 * test/helpers/fakeSupabase.js models the query builder, and this module never
 * touches it -- the counter is a single rpc, on purpose.
 */
function rpcStub(handler) {
  const calls = [];
  return {
    calls,
    client: {
      async rpc(name, args) {
        calls.push({ name, args });
        return handler(name, args);
      },
    },
  };
}

function headers(map) {
  return new Headers(map);
}

describe('signupsPerWindow', () => {
  it('defaults to 5', () => {
    assert.equal(limit.signupsPerWindow(), 5);
  });

  it('honours SIGNUP_MAX_PER_HOUR', () => {
    process.env.SIGNUP_MAX_PER_HOUR = '3';
    assert.equal(limit.signupsPerWindow(), 3);
  });

  it('a typo falls back to the default instead of removing the cap', () => {
    for (const bad of ['0', '-1', 'abc', '']) {
      process.env.SIGNUP_MAX_PER_HOUR = bad;
      assert.equal(limit.signupsPerWindow(), 5, `"${bad}" should not disable the cap`);
    }
  });
});

describe('signupIpKey', () => {
  it('prefers x-real-ip, which the proxy sets and the caller cannot', () => {
    const a = limit.signupIpKey(headers({ 'x-real-ip': '203.0.113.7' }));
    const b = limit.signupIpKey(
      headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })
    );
    assert.equal(a, b);
  });

  it('falls back to the LAST forwarded entry, so a caller cannot pick their bucket', () => {
    // A caller sending their own x-forwarded-for gets it appended to, not
    // replaced. Reading the first entry would let them choose the counter.
    const spoofed = limit.signupIpKey(
      headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.7' })
    );
    const honest = limit.signupIpKey(headers({ 'x-forwarded-for': '203.0.113.7' }));
    assert.equal(spoofed, honest);

    const chosen = limit.signupIpKey(headers({ 'x-forwarded-for': '1.2.3.4' }));
    assert.notEqual(spoofed, chosen);
  });

  it('separates different addresses and is stable for the same one', () => {
    const one = limit.signupIpKey(headers({ 'x-real-ip': '203.0.113.7' }));
    const same = limit.signupIpKey(headers({ 'x-real-ip': '203.0.113.7' }));
    const other = limit.signupIpKey(headers({ 'x-real-ip': '203.0.113.8' }));
    assert.equal(one, same);
    assert.notEqual(one, other);
  });

  it('is a hash, never the address itself', () => {
    const key = limit.signupIpKey(headers({ 'x-real-ip': '203.0.113.7' }));
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes('203'));
  });

  it('an unreadable address shares one bucket rather than skipping the cap', () => {
    const a = limit.signupIpKey(headers({}));
    const b = limit.signupIpKey(headers({ 'x-forwarded-for': '  ,  ' }));
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b);
  });
});

describe('checkSignupRateLimit', () => {
  it('admits an attempt under the cap', async () => {
    const stub = rpcStub(() => ({ data: [{ allowed: true, used: 2, retry_after_ms: 0 }], error: null }));
    const res = await limit.checkSignupRateLimit(stub.client, 'key-1');
    assert.equal(res.ok, true);
    assert.equal(res.used, 2);
    assert.equal(res.max, 5);
    assert.equal(res.degraded, false);
  });

  it('refuses over the cap with 429 and a wait the caller can read', async () => {
    const stub = rpcStub(() => ({
      data: [{ allowed: false, used: 6, retry_after_ms: 120000 }],
      error: null,
    }));
    const res = await limit.checkSignupRateLimit(stub.client, 'key-1');
    assert.equal(res.ok, false);
    assert.equal(res.status, 429);
    assert.equal(res.code, limit.SIGNUP_RATE_LIMITED);
    assert.match(res.error, /2 minutes/);
  });

  it('hands the configured window and cap to the counter', async () => {
    process.env.SIGNUP_MAX_PER_HOUR = '9';
    const stub = rpcStub(() => ({ data: [{ allowed: true, used: 1 }], error: null }));
    await limit.checkSignupRateLimit(stub.client, 'key-abc');
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].name, 'bump_signup_attempts');
    assert.deepEqual(stub.calls[0].args, {
      p_ip_key: 'key-abc',
      p_window_ms: limit.SIGNUP_WINDOW_MS,
      p_max: 9,
    });
  });

  it('reads a bare object as well as a single-row array', async () => {
    const stub = rpcStub(() => ({ data: { allowed: false, used: 6, retry_after_ms: 5000 }, error: null }));
    const res = await limit.checkSignupRateLimit(stub.client, 'key-1');
    assert.equal(res.ok, false);
    assert.equal(res.used, 6);
  });

  it('never reports a wait under a second', async () => {
    const stub = rpcStub(() => ({ data: [{ allowed: false, used: 6, retry_after_ms: 0 }], error: null }));
    const res = await limit.checkSignupRateLimit(stub.client, 'key-1');
    assert.equal(res.ok, false);
    assert.match(res.error, /1 second/);
  });

  it('degrades open, and says so, when the migration has not landed', async () => {
    const stub = rpcStub(() => ({
      data: null,
      error: { code: '42883', message: 'function public.bump_signup_attempts does not exist' },
    }));
    const res = await limit.checkSignupRateLimit(stub.client, 'key-1');
    assert.equal(res.ok, true);
    assert.equal(res.degraded, true);
  });

  it('degrades open on a transient failure rather than closing signup', async () => {
    const stub = rpcStub(() => ({ data: null, error: { message: 'connection reset' } }));
    const res = await limit.checkSignupRateLimit(stub.client, 'key-1');
    assert.equal(res.ok, true);
    assert.equal(res.degraded, true);
  });

  it('degrades open when the counter returns nothing at all', async () => {
    const stub = rpcStub(() => ({ data: [], error: null }));
    const res = await limit.checkSignupRateLimit(stub.client, 'key-1');
    assert.equal(res.ok, true);
    assert.equal(res.degraded, true);
  });
});

describe('honeypot', () => {
  it('an untouched field is not a bot', () => {
    assert.equal(honeypot.isHoneypotFilled({ [honeypot.HONEYPOT_FIELD]: '' }), false);
  });

  it('a field the form never sent is not a bot', () => {
    assert.equal(honeypot.isHoneypotFilled({ email: 'a@b.com' }), false);
  });

  it('whitespace is not a bot, so autofill cannot lock a person out', () => {
    assert.equal(honeypot.isHoneypotFilled({ [honeypot.HONEYPOT_FIELD]: '   ' }), false);
  });

  it('a filled field is a bot', () => {
    assert.equal(honeypot.isHoneypotFilled({ [honeypot.HONEYPOT_FIELD]: 'Acme Inc' }), true);
  });

  it('survives a body that is not an object', () => {
    for (const body of [null, undefined, 'string', 42]) {
      assert.equal(honeypot.isHoneypotFilled(body), false);
    }
  });
});

describe('the signup route wires all three guards', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'app', 'api', 'auth', 'signup', 'route.ts'),
    'utf8'
  );

  it('validates the address with parseEmail, not a truthiness check', () => {
    assert.match(src, /parseEmail\(body\.email\)/);
    // The old check. If it comes back, any non-empty string is an address again.
    assert.ok(
      !/String\(body\.email \|\| ''\)/.test(src),
      'raw String(body.email) coercion is back in the signup route'
    );
  });

  it('checks the honeypot and the cap', () => {
    assert.match(src, /isHoneypotFilled\(body\)/);
    assert.match(src, /checkSignupRateLimit\(supabase, signupIpKey\(req\.headers\)\)/);
  });

  it('spends nothing on a request it was going to refuse', () => {
    // Measured inside the handler only. Searching the whole file would find the
    // import of each guard instead of its call, and imports are in a fixed
    // alphabetical-ish order that says nothing about when the guard runs.
    const handlerAt = src.indexOf('export async function POST');
    assert.ok(handlerAt > -1, 'signup route no longer exports a POST handler');
    const body = src.slice(handlerAt);

    const trap = body.indexOf('isHoneypotFilled(body)');
    const address = body.indexOf('parseEmail(body.email)');
    const cap = body.indexOf('checkSignupRateLimit(');
    const insert = body.indexOf(".from('accounts')");

    assert.ok(trap > -1 && address > -1 && cap > -1 && insert > -1);
    // Free checks first, then the one that costs a round trip, then the write.
    assert.ok(trap < address, 'honeypot must be checked before anything else');
    assert.ok(address < cap, 'a malformed address must not spend the caller budget');
    assert.ok(cap < insert, 'the cap must be counted before the account row is written');
  });
});
