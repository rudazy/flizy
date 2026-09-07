/**
 * History is one question with one answer, whichever surface asks it.
 *
 * Chat and the site were two implementations that disagreed, and the sharpest
 * disagreement was this: chat looked up transfers under **the key of the
 * channel you happened to be typing on**. An account linked to WhatsApp and
 * Telegram has rows under both, so a user who sent from WhatsApp and then typed
 * `history` on Telegram was shown a short list with nothing to say part of it
 * was missing. The site had always looked under every identity.
 *
 * The first test here fails against the old chat code. That is the point of it.
 *
 * Run: node --test test/history.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { loadSettledHistory, transferKeysForAccount, LIMITS } = require('../lib/history');
const { identityTransferKey } = require('../lib/channelKey');

const ACCOUNT = 'acc-1';
const WA = '2348012345678';
const TG = '55501';

let fake;

/** @param {object} seed */
function db(seed) {
  fake = createFakeSupabase({
    accounts: [{ id: ACCOUNT, username: 'both' }],
    channel_identities: [
      { id: 'i1', account_id: ACCOUNT, channel: 'whatsapp', external_id: WA, phone_e164: WA },
      { id: 'i2', account_id: ACCOUNT, channel: 'telegram', external_id: TG, phone_e164: null },
    ],
    transfers: [],
    claims: [],
    ...seed,
  });
  return fake.client;
}

function transfer(id, over = {}) {
  return {
    id,
    account_id: null,
    phone: null,
    amount_eth: '0.01',
    asset: 'ETH',
    to_address: '0x1111111111111111111111111111111111111111',
    status: 'confirmed',
    tx_hash: `0x${id}`,
    kind: 'transfer',
    direction: 'out',
    created_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function claim(id, over = {}) {
  return {
    id,
    from_account_id: null,
    to_account_id: null,
    amount_eth: '0.02',
    asset: 'ETH',
    status: 'pending',
    created_at: '2026-09-02T00:00:00.000Z',
    claimed_at: null,
    ...over,
  };
}

beforeEach(() => {
  fake = null;
});

describe('the key set an account is known by', () => {
  it('covers every linked identity, not just the one asking', async () => {
    const client = db({});
    const keys = await transferKeysForAccount(client, ACCOUNT, null);
    assert.deepEqual(keys.sort(), [identityTransferKey('telegram', TG), WA].sort());
  });

  it('keeps an unlinked chat visible through its own key', async () => {
    const client = db({ channel_identities: [] });
    const keys = await transferKeysForAccount(client, null, 'telegram:99');
    assert.deepEqual(keys, ['telegram:99']);
  });

  it('skips an identity on a channel it cannot key safely', async () => {
    // Guessing a key for an unknown channel could collide with a real phone.
    const client = db({
      channel_identities: [{ id: 'i9', account_id: ACCOUNT, channel: 'carrier-pigeon', external_id: '7' }],
    });
    assert.deepEqual(await transferKeysForAccount(client, ACCOUNT, null), []);
  });
});

describe('the bug: one channel used to hide the other', () => {
  it('returns rows keyed to WhatsApp and to Telegram together', async () => {
    const client = db({
      transfers: [
        transfer('wa-row', { phone: WA, created_at: '2026-09-01T10:00:00.000Z' }),
        transfer('tg-row', {
          phone: identityTransferKey('telegram', TG),
          created_at: '2026-09-01T11:00:00.000Z',
        }),
      ],
    });

    const { items } = await loadSettledHistory(client, ACCOUNT, {
      transferKey: identityTransferKey('telegram', TG),
    });

    const ids = items.map((i) => i.row.id);
    assert.equal(items.length, 2, JSON.stringify(ids));
    assert.deepEqual(ids, ['tg-row', 'wa-row'], 'newest first');
  });

  it('does not double count a row that matches both account and key', async () => {
    const client = db({
      transfers: [transfer('dup', { account_id: ACCOUNT, phone: WA })],
    });
    const { items } = await loadSettledHistory(client, ACCOUNT, { transferKey: WA });
    assert.equal(items.length, 1);
  });
});

describe('claims sit in the same list as transfers', () => {
  it('merges both directions and orders everything by time', async () => {
    const client = db({
      transfers: [transfer('t1', { account_id: ACCOUNT, created_at: '2026-09-03T00:00:00.000Z' })],
      claims: [
        claim('c-out', { from_account_id: ACCOUNT, created_at: '2026-09-04T00:00:00.000Z' }),
        claim('c-in', {
          to_account_id: ACCOUNT,
          status: 'claimed',
          claimed_at: '2026-09-05T00:00:00.000Z',
        }),
      ],
    });

    const { items } = await loadSettledHistory(client, ACCOUNT, {});
    assert.deepEqual(
      items.map((i) => i.row.id),
      ['c-in', 'c-out', 't1']
    );
    assert.deepEqual(
      items.map((i) => i.source),
      ['claim', 'claim', 'transfer']
    );
  });

  it('keeps an incoming claim whatever its status', async () => {
    // Chat used to require status = 'claimed' here and the site did not, so the
    // same account showed different history depending on where you looked.
    const client = db({
      claims: [claim('c-pending', { to_account_id: ACCOUNT, status: 'pending' })],
    });
    const { items } = await loadSettledHistory(client, ACCOUNT, {});
    assert.deepEqual(items.map((i) => i.row.id), ['c-pending']);
  });

  it('reads no claims at all for a chat with no account', async () => {
    const client = db({ claims: [claim('c1', { to_account_id: ACCOUNT })] });
    const { items } = await loadSettledHistory(client, null, { transferKey: WA });
    assert.equal(items.length, 0);
  });
});

describe('the list is capped', () => {
  it('returns at most the result limit, newest first', async () => {
    const transfers = [];
    for (let i = 0; i < LIMITS.result + 12; i += 1) {
      transfers.push(
        transfer(`t${String(i).padStart(3, '0')}`, {
          account_id: ACCOUNT,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        })
      );
    }
    const client = db({ transfers });

    const { items } = await loadSettledHistory(client, ACCOUNT, {});
    assert.equal(items.length, LIMITS.result);

    const times = items.map((i) => new Date(i.createdAt).getTime());
    const sorted = [...times].sort((a, b) => b - a);
    assert.deepEqual(times, sorted, 'not newest first');
  });
});
