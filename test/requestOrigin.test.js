/**
 * Origin allowlist for money POSTs.
 * Run: node --test test/requestOrigin.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

describe('isAllowedOrigin', () => {
  let web;

  before(async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://flizy.app';
    process.env.NODE_ENV = 'test';
    delete process.env.VERCEL_ENV;
    web = await import('../web/lib/requestOrigin.ts');
  });

  it('accepts the configured site origin', () => {
    const req = new Request('https://flizy.app/api/pay/execute', {
      method: 'POST',
      headers: { origin: 'https://flizy.app' },
    });
    assert.equal(web.isAllowedOrigin(req), true);
  });

  it('rejects a foreign origin', () => {
    const req = new Request('https://flizy.app/api/pay/execute', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(web.isAllowedOrigin(req), false);
  });

  it('allows a missing origin outside production (curl / tests)', () => {
    const req = new Request('https://flizy.app/api/pay/execute', { method: 'POST' });
    assert.equal(web.isAllowedOrigin(req), true);
  });
});


describe('a local dev server on its own port only', () => {
  let mod;
  before(async () => {
    mod = await import('../web/lib/requestOrigin.ts');
  });

  /**
   * A development build accepts the dev server's own origin: localhost or
   * 127.0.0.1 on PORT (3000 when unset). Any other local port is some other
   * service, and accepting it would let that service post with the dev
   * session's cookie.
   */
  const req = (origin, env) => {
    const keys = ['NODE_ENV', 'VERCEL_ENV', 'PORT'];
    const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      const headers = new Headers();
      if (origin) headers.set('origin', origin);
      return mod.isAllowedOrigin(new Request('http://localhost/api/x', { method: 'POST', headers }));
    } finally {
      for (const k of keys) {
        if (previous[k] === undefined) delete process.env[k];
        else process.env[k] = previous[k];
      }
    }
  };

  const DEV = { NODE_ENV: 'development', VERCEL_ENV: '', PORT: undefined };
  const DEV_3001 = { NODE_ENV: 'development', VERCEL_ENV: '', PORT: '3001' };
  const PROD = { NODE_ENV: 'production', VERCEL_ENV: 'production', PORT: '3001' };

  it('accepts localhost on the default port', () => {
    assert.equal(req('http://localhost:3000', DEV), true);
    assert.equal(req('http://127.0.0.1:3000', DEV), true);
  });

  it('accepts localhost on the port the dev server was started on', () => {
    assert.equal(req('http://localhost:3001', DEV_3001), true);
    assert.equal(req('http://127.0.0.1:3001', DEV_3001), true);
  });

  it('refuses any other local port, which is a different service', () => {
    for (const o of [
      'http://localhost:3001',
      'http://localhost:4123',
      'http://127.0.0.1:8080',
      'http://[::1]:3000',
      'http://localhost',
    ]) {
      assert.equal(req(o, DEV), false, o);
    }
    assert.equal(req('http://localhost:4123', DEV_3001), false);
  });

  it('ignores a PORT that is not a port', () => {
    assert.equal(req('http://localhost:3001', { ...DEV, PORT: '3001x' }), false);
  });

  it('does not accept a localhost claim in production', () => {
    // Production keeps the named list only; PORT does not widen it.
    assert.equal(req('http://localhost:3001', PROD), false);
    assert.equal(req('http://127.0.0.1:9999', PROD), false);
  });

  it('still refuses anything dressed up to look local', () => {
    for (const o of [
      'http://localhost.evil.test',
      'http://evil.test/localhost',
      'https://localhost.attacker.com:3001',
      'http://notlocalhost:3001',
      'http://localhost:3001.evil.test',
    ]) {
      assert.equal(req(o, DEV_3001), false, o);
    }
  });
});

describe('login asks for the emailed code on every runtime', () => {
  /**
   * The code defends a real account against a stolen password. It is never
   * skipped by environment: a development build goes through the same step and
   * gets the code back as devCode because it has no mail transport.
   */
  const fs = require('node:fs');
  const path = require('node:path');
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'app', 'api', 'auth', 'login', 'route.ts'),
    'utf8'
  );

  it('only a remembered browser skips the code', () => {
    assert.match(SRC, /const remembered = hasTrustedLoginDevice\(data\.id\);/);
  });

  it('there is no environment switch around it', () => {
    assert.doesNotMatch(SRC, /isProd\(|NODE_ENV|VERCEL_ENV/);
  });

  it('the code path itself is present', () => {
    assert.match(SRC, /issueEmailVerificationCode\(/);
    assert.match(SRC, /consumeEmailVerificationCode\(/);
    assert.match(SRC, /needsCode: true/);
  });
});
