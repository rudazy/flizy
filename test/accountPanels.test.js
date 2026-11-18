/**
 * Account > Business and Account > Rewards, as drawn: the summary and the
 * headings beside the business terms, and what each reward entry was for.
 *
 * Covers: a heading for every terms line, and the summary saying what the
 * first line says; each reward entry carries a kind the page filters and
 * draws by; every kind has an icon and sits under a filter; the panels keep
 * to the routes they read and write.
 *
 * Run: node --test test/accountPanels.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const V = require('../lib/rewardsView');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ME = '11111111-1111-4111-8111-111111111111';

let T;
before(async () => {
  T = await import('../web/lib/businessTerms.ts');
});

describe('business terms on the panel', () => {
  it('one short heading per terms line', () => {
    assert.equal(T.BUSINESS_TERM_HEADINGS.length, T.BUSINESS_TERMS.length);
    for (const h of T.BUSINESS_TERM_HEADINGS) assert.ok(h.length > 0 && h.length <= 32, h);
  });

  it('the summary says what the first line says', () => {
    assert.ok(T.BUSINESS_TERMS[0].includes(T.BUSINESS_FEE_SUMMARY.fee));
    assert.ok(T.BUSINESS_TERMS[0].includes(T.BUSINESS_FEE_SUMMARY.minimum));
  });

  it('draws an icon for every line, and falls back to the plain list when they do not line up', () => {
    const panel = read('web/components/BusinessAccountPanel.tsx');
    const icons = panel.slice(panel.indexOf('const TERM_ICONS'), panel.indexOf('];', panel.indexOf('const TERM_ICONS')));
    assert.equal((icons.match(/<[A-Za-z]+Icon /g) || []).length, T.BUSINESS_TERMS.length);
    assert.match(panel, /view\.terms\.lines\.length === BUSINESS_TERM_HEADINGS\.length/);
    assert.match(panel, /fetch\('\/api\/account\/business', \{ cache: 'no-store' \}\)/);
  });
});

describe('reward entries', () => {
  it('each kind of entry in a word', () => {
    assert.equal(V.entryKind({ kind: 'cashback' }, 'swap'), 'swap');
    assert.equal(V.entryKind({ kind: 'cashback' }, 'p2p'), 'payment');
    assert.equal(V.entryKind({ kind: 'referral' }), 'referral');
    assert.equal(V.entryKind({ kind: 'merchant' }), 'business');
    assert.equal(V.entryKind({ kind: 'adjustment' }), 'adjustment');
  });

  it('loaded entries carry it', async () => {
    const fake = createFakeSupabase({
      reward_entries: [
        { account_id: ME, kind: 'cashback', usd_micro: '1000', fee_ledger_id: 'f1', from_account_id: null, created_at: '2026-11-17T10:00:00.000Z' },
        { account_id: ME, kind: 'merchant', usd_micro: '500', fee_ledger_id: 'f2', from_account_id: null, created_at: '2026-11-17T09:00:00.000Z' },
      ],
      fee_ledger: [{ id: 'f1', kind: 'swap' }],
      accounts: [],
    });
    fake.client.rpc = async () => ({ data: 1500, error: null });
    const view = await V.loadRewards(fake.client, ME);
    assert.deepEqual(view.entries.map((e) => e.kind), ['swap', 'business']);
  });

  it('the panel has an icon for every kind, and every kind sits under a filter', () => {
    const panel = read('web/components/RewardsPanel.tsx');
    for (const kind of ['swap', 'payment', 'referral', 'business', 'adjustment']) {
      assert.match(panel, new RegExp(`\\b${kind}: <[A-Za-z]+Icon `), kind);
    }
    for (const kind of ['swap', 'payment', 'referral', 'business']) {
      assert.match(panel, new RegExp(`kinds: \\[[^\\]]*'${kind}'`), kind);
    }
    assert.match(panel, /\{ id: 'all', label: 'All activity', kinds: null \}/);
    assert.match(panel, /fetch\('\/api\/account\/rewards', \{ cache: 'no-store' \}\)/);
  });
});

describe('the panels', () => {
  it('are plain ASCII', () => {
    for (const rel of ['web/components/BusinessAccountPanel.tsx', 'web/components/RewardsPanel.tsx']) {
      assert.doesNotMatch(read(rel), /[^\x00-\x7F]/, rel);
    }
  });
});
