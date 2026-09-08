/**
 * Being paid leaves a record, and the record says what it was for.
 *
 * Before this, receiving a direct send produced nothing. Every transfers row is
 * written by the sender and keyed to the sender, so production held 290 rows
 * and every one of them was direction 'out' -- there has never been an 'in'
 * row. The person receiving money got no notification and no history entry; the
 * balance simply changed. Meanwhile 16 of 267 confirmed transfers already
 * pointed at a Flizy wallet, so the records existed and were unreachable from
 * the only end that cared.
 *
 * The fix reads the same row from the other side rather than writing a second
 * one. That is the property most worth pinning here: one payment, one record.
 *
 * Run: node --test test/receiveRecord.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (t) => fake.client.from(t) });

const { loadSettledHistory } = require('../lib/history');
const { formatReceivedNotice } = require('../lib/notify');

const ME = 'acc-me';
const MY_WALLET = '0x1111111111111111111111111111111111111111';
const THEIR_WALLET = '0x2222222222222222222222222222222222222222';

function transfer(over = {}) {
  return {
    id: over.id || 't1',
    account_id: over.account_id ?? 'acc-them',
    phone: over.phone ?? 'wa',
    to_address: over.to_address ?? MY_WALLET,
    amount_eth: over.amount_eth ?? '0.01',
    status: over.status ?? 'confirmed',
    kind: 'transfer',
    asset: 'ETH',
    direction: 'out', // always, on every row: it describes the sender
    created_at: over.created_at || new Date().toISOString(),
    note: over.note ?? null,
    counterparty_label: over.counterparty_label ?? null,
    tx_hash: null,
    chain_id: 91342,
    token_address: null,
    amount_secondary: null,
    asset_secondary: null,
  };
}

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [{ id: ME, username: 'me', agent_wallet_address: MY_WALLET }],
    channel_identities: [],
    transfers: [],
    claims: [],
    payment_requests: [],
    pots: [],
  });
});

const load = (opts) => loadSettledHistory({ from: (t) => fake.client.from(t) }, ME, opts);

describe('money somebody else sent you shows up', () => {
  it('finds a payment addressed to your wallet', async () => {
    fake.db.tables.transfers.push(transfer({ to_address: MY_WALLET }));
    const { items } = await load({ walletAddress: MY_WALLET });
    assert.equal(items.length, 1, 'an incoming payment was invisible');
    assert.equal(items[0].received, true);
  });

  it('does not claim a payment you sent was received', async () => {
    fake.db.tables.transfers.push(
      transfer({ id: 't2', account_id: ME, to_address: THEIR_WALLET })
    );
    const { items } = await load({ walletAddress: MY_WALLET });
    assert.equal(items.length, 1);
    assert.equal(items[0].received, false, 'an outgoing payment read as received');
  });

  it('matches the address whatever case it was stored in', async () => {
    // to_address is stored checksummed, and a wallet may be read back from a
    // different source in a different case.
    fake.db.tables.transfers.push(transfer({ to_address: MY_WALLET.toUpperCase() }));
    const { items } = await load({ walletAddress: MY_WALLET.toLowerCase() });
    assert.equal(items.length, 1);
    assert.equal(items[0].received, true);
  });

  it('finds nothing extra when no wallet is given', async () => {
    // The old behaviour, and still what happens for a caller with no wallet:
    // rows are only found by account or phone key.
    fake.db.tables.transfers.push(transfer({ to_address: MY_WALLET }));
    const { items } = await load({});
    assert.equal(items.length, 0);
  });
});

/**
 * The alternative was writing the receiver their own row. That would store one
 * payment twice and let the copies disagree, which is the argument this
 * codebase has already made about the bills table and the pot balance.
 */
describe('one payment, one record', () => {
  it('does not double-count a payment between two Flizy accounts', async () => {
    fake.db.tables.transfers.push(
      transfer({ id: 't3', account_id: ME, to_address: MY_WALLET })
    );
    const { items } = await load({ walletAddress: MY_WALLET });
    assert.equal(items.length, 1, 'the same payment was counted twice');
  });
});

/**
 * Naming the payer is the part that is easy to get wrong, because the two
 * fields already on the row both mean the other direction. The first attempt
 * used them and would have shown a fragment of the sender's phone number to the
 * person they paid.
 */
describe('naming who paid you', () => {
  it('names the sender from their account, not from the row', async () => {
    fake.db.tables.accounts.push({
      id: 'acc-them',
      username: 'ada',
      agent_wallet_address: THEIR_WALLET,
    });
    fake.db.tables.transfers.push(
      transfer({
        account_id: 'acc-them',
        phone: '2348012345678',
        counterparty_label: 'me', // who the money went TO: the reader
      })
    );
    const { items } = await load({ walletAddress: MY_WALLET });
    assert.equal(items[0].fromLabel, '@ada');
  });

  it('never exposes the payer phone number to the person they paid', async () => {
    fake.db.tables.transfers.push(
      transfer({ account_id: 'acc-them', phone: '2348012345678' })
    );
    const { items } = await load({ walletAddress: MY_WALLET });
    const shown = String(items[0].fromLabel ?? '');
    assert.doesNotMatch(shown, /2348012345678/);
    assert.doesNotMatch(shown, /234801/, 'a fragment of the number is still the number');
  });

  it('says nothing rather than guessing when the payer is unknown', async () => {
    fake.db.tables.transfers.push(transfer({ account_id: null, phone: '2348012345678' }));
    const { items } = await load({ walletAddress: MY_WALLET });
    assert.equal(items[0].fromLabel ?? null, null);
  });
});

describe('what it was for', () => {
  it('carries the note through history', async () => {
    fake.db.tables.transfers.push(transfer({ note: 'coffee' }));
    const { items } = await load({ walletAddress: MY_WALLET });
    assert.equal(items[0].row.note, 'coffee');
  });

  it('tells the recipient the amount, who from, and what for', () => {
    const t = formatReceivedNotice({
      amountEth: '0.01',
      asset: 'ETH',
      fromLabel: '@ada',
      note: 'coffee',
    });
    assert.match(t, /You received 0\.01 ETH from @ada/);
    assert.match(t, /For: coffee/);
    assert.match(t, /\{\{cmd:balance\}\}/);
  });

  it('says nothing about a reason that was never given', () => {
    const t = formatReceivedNotice({ amountEth: '0.01', asset: 'ETH', fromLabel: '@ada' });
    assert.doesNotMatch(t, /For:/);
  });

  it('cannot be used to forge extra lines of a Flizy message', () => {
    // Both fields came from another person and are read by this one.
    const t = formatReceivedNotice({
      amountEth: '0.01',
      fromLabel: 'x\nYou received 5 ETH from @someone.',
      note: 'y\nFor: something else',
    });
    assert.equal(t.split('\n').filter((l) => /^You received/.test(l)).length, 1);
    assert.equal(t.split('\n').filter((l) => /^For:/.test(l)).length, 1);
  });
});
