/**
 * Scan's feed is every Flizy account, and the public row drops anything that
 * is not the ledger. History stays the signed-in account.
 *
 * Run: node --test test/flizyFeed.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let feed;
before(async () => {
  feed = await import('../web/lib/flizyFeed.ts');
});

const PHONE = '2348012345678';
const EMAIL = 'person@example.com';
const HASH = '0x' + 'ab'.repeat(32);
const KEYS = [
  'id', 'type', 'direction', 'amount', 'asset', 'amountSecondary', 'assetSecondary',
  'counterparty', 'status', 'txHash', 'createdAt', 'note', 'label', 'category', 'channel', 'actor', 'rail',
];

function assertPublic(item, secret) {
  for (const key of Object.keys(item)) assert.ok(KEYS.includes(key), key);
  const packed = JSON.stringify(item);
  assert.ok(!packed.includes(secret), secret);
  assert.ok(!packed.includes('account_id'));
  assert.ok(!packed.includes(EMAIL));
}

describe('a transfer from any account', () => {
  it('names the account and the channel, and drops the phone key and the note', () => {
    const item = feed.scanTransferItem({
      id: 'row-1',
      account_id: '11111111-1111-1111-1111-111111111111',
      amount_eth: '0.01',
      to_address: '0x1234567890abcdef1234567890abcdef12345678',
      status: 'confirmed',
      tx_hash: HASH,
      created_at: '2026-10-06T12:00:00.000Z',
      phone: PHONE,
      kind: 'transfer',
      asset: 'ETH',
      note: 'rent',
    }, 'Ada');
    assertPublic(item, PHONE);
    assert.equal(item.actor, '@ada');
    assert.equal(item.channel, 'WhatsApp');
    assert.equal(item.category, 'send');
    assert.equal(item.direction, 'out');
    // The note is the sender's own: it stays in their History.
    assert.equal(item.note, null);
    assert.equal(item.txHash, HASH);
    assert.ok(!JSON.stringify(item).includes('11111111'));
  });

  it('drops a phone or an email written into the label or the note', () => {
    const item = feed.scanTransferItem({
      id: 'row-private',
      amount_eth: '0.01',
      to_address: PHONE,
      counterparty_label: `+${PHONE}`,
      note: `reach ${EMAIL} or +${PHONE}`,
      status: 'confirmed',
      created_at: '2026-10-06T12:00:00.000Z',
      kind: 'transfer',
      asset: 'ETH',
    }, 'ada');
    assertPublic(item, PHONE);
    const again = feed.scanTransferItem({
      id: 'row-private-2',
      amount_eth: '0.02',
      counterparty_label: EMAIL,
      note: `+${PHONE}`,
      status: 'confirmed',
      created_at: '2026-10-06T12:00:00.000Z',
    }, 'ada');
    assertPublic(again, PHONE);
    assert.equal(again.note, null);
    assert.equal(again.counterparty, null);
    assert.equal(item.counterparty, null);
    assert.equal(item.label, 'Sent 0.01 ETH');
    assert.equal(item.note, null);
  });

  it('names a Flizy payee only while each side shows its username on Scan', () => {
    const to = '0x1234567890abcdef1234567890abcdef12345678';
    const pay = (sender, recipient) => feed.scanTransferItem({
      id: 'row-pay',
      amount_eth: '1',
      to_address: to,
      counterparty_label: '@bob',
      note: 'rent',
      status: 'confirmed',
      created_at: '2026-10-06T12:00:00.000Z',
    }, sender, recipient);
    // Both shown: sender leads, payee named, the rail is its own line.
    const both = pay('carol', { username: 'bob' });
    assert.equal(both.actor, '@carol');
    assert.equal(both.label, 'Sent 1 ETH → @bob');
    assert.equal(both.counterparty, '@bob');
    assert.equal(both.rail, 'Flizy pay');
    // Payee hid it: their short wallet instead.
    const payeeHidden = pay('carol', { username: null });
    assert.equal(payeeHidden.label, 'Sent 1 ETH → 0x1234...5678');
    assert.equal(payeeHidden.counterparty, to);
    assert.equal(payeeHidden.rail, 'Flizy pay');
    assert.ok(!JSON.stringify(payeeHidden).includes('bob'));
    // Both hid it: nobody named, the rail leads.
    const none = pay(null, { username: null });
    assert.equal(none.actor, null);
    assert.equal(none.label, 'Flizy pay · Sent 1 ETH → 0x1234...5678');
    for (const secret of ['bob', 'carol', 'rent']) assert.ok(!JSON.stringify(none).includes(secret), secret);
    // Unmatched address but logged as a Flizy pay: still the rail, never the label's name.
    const unmatched = pay('carol', null);
    assert.equal(unmatched.rail, 'Flizy pay');
    assert.equal(unmatched.label, 'Sent 1 ETH → 0x1234...5678');
    assert.ok(!JSON.stringify(unmatched).includes('bob'));
  });

  it('never shows a saved name or a display name', () => {
    for (const label of ['john', 'Ada Lovelace', 'paycode77']) {
      const item = feed.scanTransferItem({
        id: 'row-named',
        amount_eth: '1',
        to_address: '0x1234567890abcdef1234567890abcdef12345678',
        counterparty_label: label,
        status: 'confirmed',
        created_at: '2026-10-06T12:00:00.000Z',
      }, 'ada');
      assert.ok(!JSON.stringify(item).includes(label), label);
      assert.equal(item.label, 'Sent 1 ETH → 0x1234...5678');
      assert.equal(item.rail, null);
    }
  });

  it('keeps marketplace labels, which name collections and tokens', () => {
    const item = feed.scanTransferItem({
      id: 'row-nft',
      kind: 'nft_market',
      amount_eth: '0.1',
      counterparty_label: 'Buy Franky #3 for 0.1 ETH',
      status: 'confirmed',
      created_at: '2026-10-06T12:00:00.000Z',
    }, 'ada');
    assert.equal(item.label, 'Buy Franky #3 for 0.1 ETH');
  });

  it('turns a platform key into a name and refuses a username that is not one', () => {
    const item = feed.scanTransferItem({
      id: 'row-2',
      phone: 'telegram:99887766',
      kind: 'swap',
      amount_eth: '1',
      asset: 'ETH',
      amount_secondary: '1000',
      asset_secondary: 'FLZ',
      status: 'confirmed',
      created_at: '2026-10-06T12:00:00.000Z',
    }, '+2348012345678');
    assertPublic(item, '99887766');
    assert.equal(item.actor, null);
    assert.equal(item.channel, 'Telegram');
    assert.equal(item.type, 'swap');
    assert.equal(item.category, 'swap');
  });
});

describe('a claim from any account', () => {
  it('names the rail and keeps the phone, the email, and the external id off the row', () => {
    const item = feed.scanClaimItem({
      id: 'claim-1',
      from_account_id: '22222222-2222-2222-2222-222222222222',
      to_channel: null,
      to_wa_hint: PHONE,
      to_email: EMAIL,
      to_display_handle: PHONE,
      to_external_id: '99887766',
      amount_eth: '0.2',
      asset: 'ETH',
      status: 'pending',
      hold_tx_hash: HASH,
      created_at: '2026-10-06T11:00:00.000Z',
    }, 'ada');
    assertPublic(item, PHONE);
    assert.ok(!JSON.stringify(item).includes('99887766'));
    assert.equal(item.actor, '@ada');
    assert.equal(item.label, 'Email pay · held · 0.2 ETH');
    assert.equal(item.counterparty, null);
    assert.equal(item.txHash, HASH);
    assert.equal(item.category, 'claim');
  });

  it('shows the rail only, never the recipient handle', () => {
    const shown = feed.scanClaimItem({
      id: 'claim-2',
      to_channel: 'github',
      to_display_handle: 'octocat',
      status: 'claimed',
      claim_tx_hash: HASH,
      amount_eth: '1',
      asset: 'ETH',
      created_at: '2026-10-01T00:00:00.000Z',
      claimed_at: '2026-10-06T15:00:00.000Z',
    }, 'ada');
    assert.equal(shown.label, 'GitHub pay · claimed · 1 ETH');
    assert.equal(shown.counterparty, null);
    assert.ok(!JSON.stringify(shown).includes('octocat'));
    assert.equal(shown.createdAt, '2026-10-06T15:00:00.000Z');
    const hidden = feed.scanClaimItem({
      id: 'claim-3',
      to_channel: 'telegram',
      to_display_handle: '99887766',
      to_wa_hint: PHONE,
      status: 'pending',
      amount_eth: '1',
      created_at: '2026-10-06T10:00:00.000Z',
    }, 'no');
    assert.equal(hidden.actor, null);
    assert.equal(hidden.label, 'Telegram pay · held · 1 ETH');
    assert.ok(!JSON.stringify(hidden).includes(PHONE));
    assert.ok(!JSON.stringify(hidden).includes('99887766'));
  });
});

describe('a focus', () => {
  it('accepts a whole username or a whole address, and nothing partial', () => {
    assert.deepEqual(feed.parseScanFocus('  @Whuffi '), { kind: 'username', username: 'whuffi' });
    assert.deepEqual(feed.parseScanFocus('whuffi'), { kind: 'username', username: 'whuffi' });
    const address = '0x1234567890abcdef1234567890abcdef12345678';
    assert.deepEqual(feed.parseScanFocus(address.toUpperCase()), { kind: 'address', address });
    assert.equal(feed.parseScanFocus(''), null);
    assert.equal(feed.parseScanFocus('wh'), null);
    assert.equal(feed.parseScanFocus('0x1234'), null);
    assert.equal(feed.parseScanFocus('eth!'), null);
  });
});

describe('the cap', () => {
  it('keeps the newest hundred and nothing else', () => {
    const items = [];
    for (let i = 0; i < feed.FEED_LIMIT + 5; i += 1) {
      items.push({ id: String(i), createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
    }
    const merged = feed.mergeFeed(items);
    assert.equal(merged.length, feed.FEED_LIMIT);
    assert.equal(merged[0].id, String(feed.FEED_LIMIT + 4));
  });
});

describe('the route', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'api', 'scan', 'route.ts'), 'utf8');

  it('requires a session and does not filter the ledger down to that session', () => {
    assert.match(route, /getAccountIdFromCookie/);
    assert.match(route, /from\('transfers'\)/);
    assert.match(route, /from\('claims'\)/);
    assert.ok(!route.includes(".eq('account_id', accountId"));
    assert.match(route, /\.eq\('account_id', focusAccountId\)/);
    assert.match(route, /parseScanFocus/);
    assert.match(route, /storedAddress/);
    assert.match(route, /\.limit\(8\)/);
    assert.ok(!route.includes('loadSettledHistory'));
    assert.ok(!route.includes('to_external_id'));
    assert.ok(!route.includes('from_wa_sender'));
  });
});
