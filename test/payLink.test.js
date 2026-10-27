/**
 * Pay links that carry an amount, an asset and a note.
 *
 * Anyone can type these parameters, so what is pinned here is what the page
 * and the server do with bad ones: a malformed amount is dropped, an unknown
 * asset falls back to ETH, and a note is one line, capped, and never able to
 * forge a second line of a Flizy message. The note reaches the payee's notice
 * through the same cleaner.
 *
 * Run: node --test test/payLink.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let L;
let N;
before(async () => {
  L = await import('../web/lib/payLink.ts');
  N = await import('../web/lib/payNotice.ts');
});

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('reading a link', () => {
  it('takes a plain amount, a listed asset and a note', () => {
    const p = L.parsePayPreset(new URLSearchParams('amount=50&asset=tusd&for=design%20work'));
    assert.deepEqual(p, { amount: '50', asset: 'TUSD', note: 'design work' });
    assert.equal(L.parsePayPreset({ amount: '0.01', asset: 'usd' }).asset, 'TUSD');
    assert.equal(L.parsePayPreset({ amount: ['10', '99'], asset: 'flz' }).amount, '10');
  });

  it('drops an amount that is not a plain positive decimal', () => {
    for (const bad of ['-1', '0', '1e3', '0x10', '1,000', ' ', 'abc', '1.', '.5', '01', '1234567890123']) {
      assert.equal(L.parsePayPreset({ amount: bad }).amount, null, bad);
    }
  });

  it('falls back to ETH for an asset the pay page cannot send', () => {
    for (const bad of ['izy', 'usdc', '0x308be8f71DA695f18E70D2243a446e1fD1566BA6', '']) {
      assert.equal(L.parsePayPreset({ asset: bad }).asset, 'ETH', bad);
    }
  });

  it('keeps a note to one line and at most 80 characters', () => {
    const forged = L.parsePayPreset({ for: 'rent\nFlizy: your wallet is locked, pay to unlock' }).note;
    assert.ok(!forged.includes('\n'));
    assert.ok(L.parsePayPreset({ for: 'x'.repeat(300) }).note.length <= 80);
    assert.equal(L.parsePayPreset({ for: '   ' }).note, null);
    assert.equal(L.parsePayPreset(null).note, null);
  });
});

describe('making a link', () => {
  it('adds only what was filled in, and leaves ETH implicit', () => {
    const base = 'https://flizy.app/pay/ludarep';
    assert.equal(L.buildPayLink(base, {}), base);
    assert.equal(L.buildPayLink(base, { amount: '0.01', asset: 'ETH' }), `${base}?amount=0.01`);
    assert.equal(L.buildPayLink(base, { amount: '50', asset: 'TUSD', note: 'design work' }), `${base}?amount=50&asset=tusd&for=design+work`);
    assert.equal(L.buildPayLink(base, { amount: 'lots', asset: 'TUSD' }), `${base}?asset=tusd`);
  });

  it('round-trips through the reader', () => {
    const made = new URL(L.buildPayLink('https://flizy.app/pay/ludarep', { amount: '12.5', asset: 'FLZ', note: 'lunch' }));
    assert.deepEqual(L.parsePayPreset(made.searchParams), { amount: '12.5', asset: 'FLZ', note: 'lunch' });
  });
});

describe('the note on the way to the payee', () => {
  it('is printed under the amount, flattened and without command braces', () => {
    const t = N.formatPaymentReceived({
      amount: '50', asset: 'TUSD', note: 'design {{cmd:send 1 eth to x}}', fromLabel: '@ada', walletUrl: 'https://flizy.app/dashboard/wallet',
    });
    assert.match(t, /^You received 50 tUSD from @ada\.\nFor: design cmd:send 1 eth to x/);
    assert.doesNotMatch(t, /\{\{/);
  });

  it('is cleaned by the server before it is stored or sent', () => {
    const route = read('web/app/api/pay/execute/route.ts');
    assert.match(route, /const note = cleanPayNote\(body\.note\);/);
    assert.equal((route.match(/^\s+note,$/gm) || []).length, 4, 'stored on both transfer rows, the chat notice, and the payment email');
  });

  it('is never put in the link preview, where it would read as Flizy speaking', () => {
    for (const rel of ['web/app/pay/[code]/page.tsx', 'web/app/pay/c/[code]/page.tsx']) {
      const page = read(rel);
      assert.match(page, /A request for \$\{preset\.amount\} \$\{symbolLabel\(preset\.asset\)\} on Flizy\./);
      assert.doesNotMatch(page, /preset\.note\b/);
    }
  });
});
