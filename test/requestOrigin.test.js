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
