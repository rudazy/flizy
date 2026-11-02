/**
 * Balance and Max on the site's spend screens leave Savings out.
 *
 * What is pinned: a balance loses exactly its own asset's Savings, matched upper
 * case (tUSD is TUSD), and never goes below zero; an unreadable Savings read
 * offers no balance at all; and the Swap page, the token trade sheet and the
 * pay link page each read their Flizy wallet balance through it.
 *
 * Run: node --test test/spendable.test.js
 */

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let S;
before(async () => {
  S = await import('../web/lib/spendable.ts');
});

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const ETH_SAVED = { asset: 'ETH', amountBase: String(4n * 10n ** 17n), decimals: 18 };
const TUSD_SAVED = { asset: 'TUSD', amountBase: '30000000', decimals: 6 };

describe('spendable', () => {
  it('takes off only that asset Savings', () => {
    assert.equal(S.spendable('1', 'ETH', [ETH_SAVED, TUSD_SAVED]), '0.6');
    assert.equal(S.spendable('50', 'tUSD', [ETH_SAVED, TUSD_SAVED]), '20');
    assert.equal(S.spendable('7', 'FLZ', [ETH_SAVED, TUSD_SAVED]), '7');
  });

  it('never goes below zero', () => {
    assert.equal(S.spendable('0.1', 'ETH', [ETH_SAVED]), '0');
  });
});

describe('fetchSavings', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const answer = (status, body) => {
    global.fetch = async () => ({ ok: status === 200, status, json: async () => body });
  };

  it('returns the rows, or none when there is no Savings book', async () => {
    answer(200, { ok: true, missing: false, rows: [ETH_SAVED] });
    assert.deepEqual(await S.fetchSavings(), [ETH_SAVED]);
    answer(200, { ok: true, missing: true, rows: [] });
    assert.deepEqual(await S.fetchSavings(), []);
  });

  it('returns null when Savings cannot be read, so no balance is offered', async () => {
    answer(503, { error: 'Could not read Savings.' });
    assert.equal(await S.fetchSavings(), null);
    global.fetch = async () => {
      throw new Error('offline');
    };
    assert.equal(await S.fetchSavings(), null);
  });
});

describe('the spend screens', () => {
  it('read Balance and Max through spendable', () => {
    for (const file of ['app/dashboard/swap/page.tsx', 'components/TokenTradeSheet.tsx', 'components/PayLanding.tsx']) {
      const src = read(file);
      assert.match(src, /fetchSavings\(\)/, file);
      assert.match(src, /spendable\(/, file);
    }
  });

  it('offer no balance when Savings could not be read', () => {
    assert.match(read('app/dashboard/swap/page.tsx'), /if \(!res\.ok \|\| !savings\) return;/);
    assert.match(read('components/PayLanding.tsx'), /if \(!res\.ok \|\| !savings\) throw new Error\('unavailable'\);/);
    assert.match(read('components/TokenTradeSheet.tsx'), /flizyEth != null && savings/);
  });
});
