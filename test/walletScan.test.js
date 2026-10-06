/**
 * Wallet Scan totals and the row list. Figures come from the loaded activity.
 * A dollar total exists only for a window of settled ETH. The sample numbers
 * from the screen mock must not appear in the source.
 *
 * Run: node --test test/walletScan.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let scan;
before(async () => {
  scan = await import('../web/lib/walletScan.ts');
});

const NOW = Date.parse('2026-10-06T12:00:00Z');
const HOUR = 3_600_000;

function row(overrides) {
  return {
    id: '1',
    type: 'transfer',
    direction: 'out',
    amount: '1',
    asset: 'ETH',
    status: 'confirmed',
    createdAt: new Date(NOW - HOUR).toISOString(),
    label: 'Sent 1 ETH',
    ...overrides,
  };
}

const listQuery = {
  range: '24h',
  now: NOW,
  chip: 'all',
  status: 'all',
  query: '',
  sort: 'latest',
};

describe('range', () => {
  it('keeps the last 24 hours and puts the boundary in the current window only', () => {
    const edge = row({ id: 'edge', createdAt: new Date(NOW - 24 * HOUR).toISOString() });
    const inside = row({ id: 'in', createdAt: new Date(NOW - HOUR).toISOString() });
    const older = row({ id: 'old', createdAt: new Date(NOW - 25 * HOUR).toISOString() });
    const current = scan.rowsInWindow([edge, inside, older], scan.scanWindow('24h', NOW));
    const previous = scan.rowsInWindow([edge, inside, older], scan.previousScanWindow('24h', NOW));
    assert.deepEqual(current.map((item) => item.id), ['edge', 'in']);
    assert.deepEqual(previous.map((item) => item.id), ['old']);
  });

  it('has no previous window for all time or a custom range', () => {
    assert.equal(scan.previousScanWindow('all', NOW), null);
    assert.equal(scan.previousScanWindow('custom', NOW), null);
  });

  it('reads a custom range as local days and swaps a reversed pair', () => {
    const local = new Date(2026, 9, 4, 15, 0, 0);
    const item = row({ createdAt: local.toISOString() });
    const onDay = scan.filterScanRows([item], {
      ...listQuery,
      range: 'custom',
      now: local.getTime(),
      from: '2026-10-04',
      to: '2026-10-04',
    });
    const nextDay = scan.filterScanRows([item], {
      ...listQuery,
      range: 'custom',
      now: local.getTime(),
      from: '2026-10-05',
      to: '2026-10-05',
    });
    const swapped = scan.filterScanRows([item], {
      ...listQuery,
      range: 'custom',
      now: local.getTime(),
      from: '2026-10-05',
      to: '2026-10-03',
    });
    assert.equal(onDay.length, 1);
    assert.equal(nextDay.length, 0);
    assert.equal(swapped.length, 1);
    assert.equal(scan.scanWindow('custom', NOW, '2026-02-29', '2026-02-29'), null);
  });
});

describe('stats', () => {
  it('prices a settled ETH window against the previous one', () => {
    const current = row({ id: 'now', amount: '1' });
    const previous = row({ id: 'then', amount: '0.5', createdAt: new Date(NOW - 30 * HOUR).toISOString() });
    const stats = scan.scanStats([current, previous], '24h', NOW, 2000);
    assert.equal(stats.volumeUsd, 2000);
    assert.equal(stats.volumePct, 100);
    assert.equal(stats.transactions, 1);
    assert.equal(stats.transactionsPct, 0);
    assert.equal(scan.formatScanUsd(stats.volumeUsd), '\u2248 $2,000.00');
    assert.equal(scan.formatScanPct(stats.volumePct), '+100%');
  });

  it('uses a hyphen when any settled row is not ETH, and ignores a failed other asset', () => {
    const eth = row({ id: 'eth', amount: '1' });
    const flz = row({ id: 'flz', asset: 'FLZ', amount: '10', type: 'swap', category: 'swap', label: '10 FLZ to ETH' });
    const failed = row({ id: 'bad', asset: 'FLZ', amount: '99', status: 'failed', label: 'Swap failed' });
    assert.equal(scan.scanStats([eth, flz], '24h', NOW, 2000).volumeUsd, null);
    assert.equal(scan.formatScanUsd(null), '-');
    assert.equal(scan.scanStats([eth, failed], '24h', NOW, 2000).volumeUsd, 2000);
  });

  it('is zero for an empty window and has no percent without a previous base', () => {
    const stats = scan.scanStats([], '24h', NOW, null);
    assert.equal(stats.volumeUsd, 0);
    assert.equal(stats.volumePct, null);
    assert.equal(stats.transactionsPct, null);
    assert.equal(scan.formatScanUsd(0), '$0.00');
    const aged = row({ amount: '2', createdAt: new Date(NOW - 10 * HOUR).toISOString() });
    const all = scan.scanStats([aged], 'all', NOW, 100);
    assert.equal(all.volumePct, null);
    assert.equal(all.transactions, 1);
    const custom = scan.scanStats([aged], 'custom', NOW, 100, '2026-10-01', '2026-10-06');
    assert.equal(custom.volumePct, null);
  });

  it('does not invent a dollar figure when the rate is missing', () => {
    assert.equal(scan.scanStats([row({})], '24h', NOW, null).volumeUsd, null);
  });

  it('leaves an undated row out of every window', () => {
    const stats = scan.scanStats([row({ createdAt: 'not-a-date' })], 'all', NOW, 100);
    assert.equal(stats.transactions, 0);
    assert.equal(stats.volumeUsd, 0);
  });
});

describe('chips, search and sort', () => {
  it('files pool, withdraw, claim and nft without inventing a pool from a send', () => {
    const liquidity = row({ id: 'pool', type: 'swap', category: 'swap', label: 'Add liquidity' });
    const sent = row({ id: 'send', type: 'transfer', label: 'Sent 1 ETH' });
    const withdraw = row({ id: 'out', type: 'withdraw', label: 'Withdraw 1 ETH' });
    const claim = row({ id: 'claim', type: 'claim', category: 'claim', label: 'Claim' });
    const nft = row({ id: 'nft', type: 'transfer', category: 'nft', label: 'Buy Giwaforge #12' });
    assert.equal(scan.scanChipOf(liquidity), 'pool');
    assert.equal(scan.scanKind(liquidity), 'POOL');
    assert.equal(scan.scanChipOf(sent), 'send');
    assert.equal(scan.scanChipOf(withdraw), 'send');
    assert.equal(scan.scanKind(withdraw), 'WITHDRAW');
    assert.equal(scan.scanChipOf(claim), 'other');
    assert.equal(scan.scanKind(claim), 'CLAIM');
    assert.equal(scan.scanChipOf(nft), 'nft');
    const stats = scan.scanStats([liquidity, sent], '24h', NOW, 100);
    assert.equal(stats.swaps, 0);
  });

  it('searches the loaded text and sorts oldest first', () => {
    const address = '0x1234567890abcdef1234567890abcdef12345678';
    const early = row({
      id: 'early',
      createdAt: new Date(NOW - 5 * HOUR).toISOString(),
      asset: 'ETH',
      assetSecondary: 'FLZ',
      amount: '1',
      amountSecondary: '1000',
      type: 'swap',
      category: 'swap',
      label: '1 ETH to 1000 FLZ',
      counterparty: address,
    });
    const late = row({ id: 'late', createdAt: new Date(NOW - HOUR).toISOString(), label: 'Sent 1 ETH' });
    const found = scan.filterScanRows([late, early], { ...listQuery, query: 'eth flz' });
    assert.deepEqual(found.map((item) => item.id), ['early']);
    assert.equal(scan.filterScanRows([late, early], { ...listQuery, query: 'bitcoin' }).length, 0);
    const oldest = scan.filterScanRows([late, early], { ...listQuery, sort: 'oldest' });
    assert.deepEqual(oldest.map((item) => item.id), ['early', 'late']);
    assert.equal(scan.scanHeadline(early), '1 ETH → 1,000 FLZ');
    assert.equal(scan.scanHeadline(row({ amount: '1000', counterparty: address })), '1,000 ETH → 0x1234...5678');
    assert.equal(
      scan.scanHeadline(row({ amount: '1000', counterparty: address, actor: '@ada' })),
      '@ada · 1,000 ETH → 0x1234...5678'
    );
    assert.equal(scan.scanHeadline(row({ amount: '1000', counterparty: address, actor: '+2348012345678' })), '1,000 ETH → 0x1234...5678');
    assert.equal(scan.scanActor(row({ actor: '@ada' })), '@ada');
    assert.equal(scan.scanActor(row({ actor: '2348012345678' })), null);
  });

  it('names the site channel and drops a chain label', () => {
    assert.equal(scan.scanChannel('Flizy app'), 'Flizy');
    assert.equal(scan.scanChannel('X'), 'X');
    assert.equal(scan.scanChannel('X Layer'), null);
    assert.equal(scan.scanChannel(''), null);
  });

  it('filters by the status tone', () => {
    const ok = row({ id: 'ok', status: 'confirmed' });
    const bad = row({ id: 'bad', status: 'failed' });
    const visible = scan.filterScanRows([ok, bad], { ...listQuery, status: 'bad' });
    assert.deepEqual(visible.map((item) => item.id), ['bad']);
  });
});

describe('explorer link', () => {
  it('accepts an https origin and a full hash, and nothing else', () => {
    const hash = '0x' + 'ab'.repeat(32);
    assert.equal(scan.explorerTxUrl('https://sepolia-explorer.giwa.io/', hash), `https://sepolia-explorer.giwa.io/tx/${hash}`);
    assert.equal(scan.explorerTxUrl('http://sepolia-explorer.giwa.io', hash), null);
    assert.equal(scan.explorerTxUrl('https://sepolia-explorer.giwa.io', '0xabc'), null);
    assert.equal(scan.explorerTxUrl('javascript:alert(1)', hash), null);
  });
});

describe('the screen does not ship the sample figures', () => {
  const web = path.join(__dirname, '..', 'web');
  const source = [
    'lib/walletScan.ts',
    'components/WalletScan.tsx',
    'app/dashboard/wallet/page.tsx',
  ].map((file) => fs.readFileSync(path.join(web, file), 'utf8')).join('\n');

  it('has none of the mock totals, rows, or chain label', () => {
    for (const needle of ['2,481', '2481.24', '24,560', '+12%', '+6%', '+20%', '+50%', '0xc4a2', 'Minted #482', 'X Layer', 'COPY TRADE', 'Approved FLZ']) {
      assert.ok(!source.includes(needle), needle);
    }
  });

  it('says when a range or a search is empty, and does not claim every event was scanned', () => {
    assert.ok(source.includes('Nothing in this range.'));
    assert.ok(source.includes('Nothing matches that search.'));
    assert.ok(!source.includes('All your onchain activity'));
  });

  it('reads every Flizy account from the scan feed, not the signed-in history', () => {
    const ui = fs.readFileSync(path.join(web, 'components', 'WalletScan.tsx'), 'utf8');
    assert.ok(ui.includes('/api/scan'));
    assert.ok(ui.includes('/api/scan?q='));
    assert.ok(ui.includes('every Flizy account'));
    assert.ok(ui.includes('Showing '));
    assert.ok(ui.includes('No account named @'));
    assert.ok(!ui.includes('activityRows'));
  });

  it('keeps money-in green and failed red, with no second blue', () => {
    const ui = fs.readFileSync(path.join(web, 'components', 'WalletScan.tsx'), 'utf8');
    assert.ok(ui.includes('#2fd27a'));
    assert.ok(ui.includes('#f05252'));
    for (const needle of ['#1d9bf0', '#627eea', '#44dcea', 'text-blue', 'bg-blue', 'indigo', 'purple', 'cyan', 'teal']) {
      assert.ok(!ui.toLowerCase().includes(needle), needle);
    }
  });
});
