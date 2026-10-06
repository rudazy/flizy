/**
 * Wallet History: the filter each row sits under, the channel a payment went
 * through (named, never the identity key), the status pill, the title, the
 * Today / Yesterday / Earlier groups and the USD line.
 *
 * Run: node --test test/historyView.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let row;
let view;
before(async () => {
  row = await import('../web/lib/historyRow.ts');
  view = await import('../web/lib/historyView.ts');
});

const base = {
  id: '1',
  type: 'transfer',
  direction: 'out',
  amount: '0.05',
  asset: 'ETH',
  status: 'confirmed',
  createdAt: '2026-10-04T10:00:00Z',
  label: 'Sent 0.05 ETH',
};

describe('channelLabel', () => {
  it('names the channel and never returns the key', () => {
    assert.equal(row.channelLabel('site'), 'Flizy app');
    assert.equal(row.channelLabel('telegram:778899131'), 'Telegram');
    assert.equal(row.channelLabel('discord:123'), 'Discord');
    assert.equal(row.channelLabel('2348012345678'), 'WhatsApp');
  });

  it('says nothing rather than guess', () => {
    for (const k of [null, '', 'unknown:1', 'abc', 42]) assert.equal(row.channelLabel(k), null, String(k));
  });
});

describe('historyCategory', () => {
  it('files every row under one filter', () => {
    assert.equal(row.historyCategory('transfer', 'nft_market'), 'nft');
    assert.equal(row.historyCategory('swap', 'swap'), 'swap');
    assert.equal(row.historyCategory('claim', null), 'claim');
    assert.equal(row.historyCategory('receive', 'transfer'), 'receive');
    assert.equal(row.historyCategory('withdraw', 'withdraw'), 'send');
    assert.equal(row.historyCategory('transfer', 'transfer'), 'send');
  });
});

describe('filters and titles', () => {
  it('filters by category, and older rows without one fall back to their type', () => {
    const nft = { ...base, category: 'nft', label: 'Buy Giwaforge #12 for 0.05 ETH' };
    const old = { ...base, type: 'swap' };
    assert.ok(view.matchesFilter(nft, 'nft'));
    assert.ok(!view.matchesFilter(nft, 'send'));
    assert.ok(view.matchesFilter(old, 'swap'));
    assert.ok(view.matchesFilter(old, 'all'));
    assert.deepEqual(view.HISTORY_FILTERS.map((f) => f.label), ['All', 'Send', 'Receive', 'Swap', 'Claim', 'NFT']);
  });

  it('titles a row by what happened', () => {
    assert.equal(view.rowTitle({ ...base, direction: 'in', type: 'receive', category: 'receive' }), 'Received');
    assert.equal(view.rowTitle({ ...base, category: 'send' }), 'Sent');
    assert.equal(view.rowTitle({ ...base, type: 'swap', category: 'swap' }), 'Swap');
    assert.equal(view.rowTitle({ ...base, category: 'nft' }), 'NFT');
    const nft = (label) => view.rowTitle({ ...base, category: 'nft', label });
    assert.equal(nft('Offer 0.05 ETH for Giwaforge #39'), 'NFT Offer');
    assert.equal(nft('Cancel offer of 0.05 ETH'), 'Offer Cancelled');
    assert.equal(nft('Mint 2 Franky'), 'NFT Mint');
    assert.equal(nft('Buy Giwaforge #12 for 0.05 ETH'), 'NFT Bought');
    assert.equal(nft('Sell Giwaforge #1 for 0.1 ETH'), 'NFT Sold');
    assert.equal(nft('Cancel listing of Giwaforge #1'), 'Listing Cancelled');
    assert.equal(nft('Set Giwaforge royalty to 5%'), 'Royalty Set');
    assert.equal(nft('Create collection Frogs'), 'Collection Created');
    assert.equal(view.rowTitle({ ...base, type: 'withdraw', category: 'send' }), 'Withdraw');
    assert.equal(view.rowTitle({ ...base, type: 'claim', category: 'claim' }), 'Claim');
    assert.equal(view.rowTitle({ ...base, type: 'receive', direction: 'in', status: 'cancelled', category: 'claim' }), 'Refund');
  });
});

describe('statusPill', () => {
  it('maps every status the history route returns', () => {
    assert.deepEqual(view.statusPill('confirmed'), { label: 'Confirmed', tone: 'good' });
    assert.deepEqual(view.statusPill('claimed'), { label: 'Claimed', tone: 'good' });
    assert.deepEqual(view.statusPill('pending'), { label: 'Pending', tone: 'pending' });
    assert.deepEqual(view.statusPill('held'), { label: 'Pending', tone: 'pending' });
    assert.deepEqual(view.statusPill('failed'), { label: 'Failed', tone: 'bad' });
    assert.deepEqual(view.statusPill('cancelled'), { label: 'Refunded', tone: 'neutral' });
    assert.deepEqual(view.statusPill('expired'), { label: 'Expired', tone: 'neutral' });
    assert.deepEqual(view.statusPill('weird'), { label: 'Weird', tone: 'neutral' });
  });
});

describe('groupByDay', () => {
  it('Today, Yesterday, Earlier by local day, newest first, empty groups left out', () => {
    const now = new Date(2026, 9, 4, 15, 0).getTime();
    const at = (d, h) => new Date(2026, 9, d, h, 0).toISOString();
    const rows = [
      { ...base, id: 'a', createdAt: at(4, 9) },
      { ...base, id: 'b', createdAt: at(4, 14) },
      { ...base, id: 'c', createdAt: at(3, 23) },
      { ...base, id: 'd', createdAt: at(1, 12) },
    ];
    const groups = view.groupByDay(rows, now);
    assert.deepEqual(groups.map((g) => g.label), ['Today', 'Yesterday', 'Earlier']);
    assert.deepEqual(groups[0].rows.map((r) => r.id), ['b', 'a']);
    assert.deepEqual(view.groupByDay([rows[3]], now).map((g) => g.key), ['earlier']);
  });
});

describe('usdLine', () => {
  it('ETH only, positive amounts, needs a rate', () => {
    assert.equal(view.usdLine('0.05', 'ETH', 2344.2), '\u2248 $117.21');
    assert.equal(view.usdLine('100', 'FLZ', 2344.2), null);
    assert.equal(view.usdLine('0', 'ETH', 2344.2), null);
    assert.equal(view.usdLine('0.05', 'ETH', null), null);
  });
});

describe('activityRows', () => {
  it('keeps a loaded activity list and only falls back when that list is empty', () => {
    const activity = [{ ...base, id: 'live' }];
    const history = [{
      id: 'old',
      amount_eth: '1',
      to_address: '0xabc',
      status: 'confirmed',
      created_at: base.createdAt,
      kind: 'swap',
      asset: 'ETH',
    }];
    assert.equal(view.activityRows(activity, history)[0].id, 'live');
    const fallback = view.activityRows([], history);
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].type, 'swap');
    assert.equal(fallback[0].direction, 'out');
    assert.equal(fallback[0].asset, 'ETH');
    assert.equal(fallback[0].label, 'Sent 1 ETH');
    assert.equal(view.activityRows([], [{ ...history[0], kind: 'transfer' }])[0].type, 'transfer');
  });
});
