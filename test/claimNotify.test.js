/**
 * A claim addressed to a number that is already on Flizy.
 *
 * Two guarantees are under test here:
 *  1. Money never lands in someone's wallet unannounced. A phone send is always
 *     an escrow hold, whether or not that number is already a Flizy user, so
 *     the recipient runs "claim" to take it and the sender can cancel until then.
 *  2. The recipient is told the moment the hold is placed, on every channel they
 *     have linked, and a number that is not on Flizy is never cold-messaged.
 *
 * Run: node --test test/claimNotify.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

const SENDER_WA = '2348011110000';
const RECIPIENT_PHONE = '2348022220000';
const RECIPIENT_TG = '55667788';
const STRANGER_PHONE = '2348099999999';

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

// lib/runtime opens a real RPC provider and demands real env; stub it
const runtimePath = require.resolve('../lib/runtime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    chain: {
      id: 'giwa_sepolia',
      name: 'GIWA Sepolia',
      chainId: 91342,
      nativeSymbol: 'ETH',
      rpcUrl: 'http://localhost:0',
    },
    supabase: { from: (table) => fake.client.from(table) },
    provider: { getBalance: async () => ethers.parseEther('5') },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

// Escrow is on-chain; the notification is what this file is about
const claimHoldCalls = [];
const executeClaimPath = require.resolve('../lib/engine/executeClaim');
const realExecuteClaim = require('../lib/engine/executeClaim');
require.cache[executeClaimPath].exports = {
  ...realExecuteClaim,
  executeClaimHold: async (args) => {
    claimHoldCalls.push(args);
    return { ok: true, claimUrl: 'https://flizy.test/claim/tok_1', txHash: '0xdead' };
  },
};

const router = require('../lib/router');
const { registerChannelSender } = require('../lib/notify');

/** Everything delivered by channel, so a test can assert who heard what. */
const delivered = { whatsapp: [], telegram: [] };
registerChannelSender('whatsapp', async (externalId, body) => {
  delivered.whatsapp.push({ externalId, body });
});
registerChannelSender('telegram', async (externalId, body) => {
  delivered.telegram.push({ externalId, body });
});

function seed({ recipientOnFlizy = true, recipientChannels = ['whatsapp', 'telegram'] } = {}) {
  const accounts = [
    {
      id: 'acc-sender',
      email: 'sender@flizy.test',
      display_name: 'Sender',
      agent_wallet_address: '0x1111111111111111111111111111111111111111',
      balance_eth: 5,
      is_admin: false,
      unlock_pin_hash: null,
      daily_send_limit_eth: null,
    },
  ];
  const identities = [
    {
      id: 'id-sender',
      account_id: 'acc-sender',
      channel: 'whatsapp',
      external_id: SENDER_WA,
      phone_e164: SENDER_WA,
    },
  ];
  const users = [
    {
      id: 'user-sender',
      phone: SENDER_WA,
      account_id: 'acc-sender',
      balance_eth: 5,
      is_admin: false,
      wallet_address: '0x1111111111111111111111111111111111111111',
    },
  ];

  if (recipientOnFlizy) {
    accounts.push({
      id: 'acc-recipient',
      email: 'recipient@flizy.test',
      display_name: 'Recipient',
      agent_wallet_address: '0x2222222222222222222222222222222222222222',
      balance_eth: 0,
      is_admin: false,
      unlock_pin_hash: null,
      daily_send_limit_eth: null,
    });
    if (recipientChannels.includes('whatsapp')) {
      identities.push({
        id: 'id-recip-wa',
        account_id: 'acc-recipient',
        channel: 'whatsapp',
        external_id: RECIPIENT_PHONE,
        phone_e164: RECIPIENT_PHONE,
      });
    }
    if (recipientChannels.includes('telegram')) {
      identities.push({
        id: 'id-recip-tg',
        account_id: 'acc-recipient',
        channel: 'telegram',
        external_id: RECIPIENT_TG,
        phone_e164: RECIPIENT_PHONE,
      });
    }
  }

  fake.db.tables.accounts = accounts;
  fake.db.tables.channel_identities = identities;
  fake.db.tables.users = users;
  fake.db.tables.sessions = [];
  fake.db.tables.claims = [];
  fake.db.tables.notifications = [];
  fake.db.tables.transfers = [];
}

/** The sender, on WhatsApp. */
function senderCtx(sent) {
  return {
    channel: 'whatsapp',
    externalId: SENDER_WA,
    key: `whatsapp:${SENDER_WA}`,
    raw: {},
    reply: async (text) => {
      sent.push(text);
    },
    resolveVerifiedPhone: async () => SENDER_WA,
  };
}

/** Drive a full send + confirm and return everything the sender saw. */
async function sendAndConfirm(to, amount = '0.01') {
  const sent = [];
  const ctx = senderCtx(sent);
  await router.handle(ctx, `flizy send ${amount} to ${to}`);
  await router.handle(ctx, 'confirm');
  return sent;
}

beforeEach(() => {
  fake = createFakeSupabase();
  mockSupabaseModule({ from: (table) => fake.client.from(table) });
  require.cache[runtimePath].exports.supabase = { from: (table) => fake.client.from(table) };
  delivered.whatsapp.length = 0;
  delivered.telegram.length = 0;
  claimHoldCalls.length = 0;
  router.pruneExpiredPending();
});

describe('a phone send is always a claim hold', () => {
  it('escrows even when that number is already a Flizy account', async () => {
    seed({ recipientOnFlizy: true });
    const sent = await sendAndConfirm(RECIPIENT_PHONE);

    assert.equal(claimHoldCalls.length, 1, 'should have gone to escrow, not a direct transfer');
    assert.equal(claimHoldCalls[0].toWaHint, RECIPIENT_PHONE);
    assert.equal(claimHoldCalls[0].amountEth, '0.01');
    assert.ok(
      sent.some((m) => m.includes('Claim held.')),
      `sender should be told the claim is held, got: ${JSON.stringify(sent)}`
    );
  });

  it('escrows for a number that is not on Flizy at all', async () => {
    seed({ recipientOnFlizy: false });
    await sendAndConfirm(STRANGER_PHONE);
    assert.equal(claimHoldCalls.length, 1);
  });
});

describe('the recipient is notified the moment the claim is held', () => {
  it('reaches every channel that number is linked on', async () => {
    seed({ recipientOnFlizy: true });
    await sendAndConfirm(RECIPIENT_PHONE, '0.1');

    assert.equal(delivered.whatsapp.length, 1, 'WhatsApp notice');
    assert.equal(delivered.telegram.length, 1, 'Telegram notice');
    assert.equal(delivered.whatsapp[0].externalId, RECIPIENT_PHONE);
    assert.equal(delivered.telegram[0].externalId, RECIPIENT_TG);
  });

  it('names the amount, the sender, and how to receive it', async () => {
    seed({ recipientOnFlizy: true });
    await sendAndConfirm(RECIPIENT_PHONE, '0.1');

    const body = delivered.whatsapp[0].body;
    assert.match(body, /Pending claim/i);
    assert.match(body, /0\.1 ETH/);
    assert.match(body, new RegExp(`\\+${SENDER_WA}`), 'should say who it is from');
    assert.match(body, /flizy claim/i, 'should say how to receive it');
  });

  it('works when the recipient is only on Telegram', async () => {
    seed({ recipientOnFlizy: true, recipientChannels: ['telegram'] });
    await sendAndConfirm(RECIPIENT_PHONE);

    assert.equal(delivered.telegram.length, 1);
    assert.equal(delivered.whatsapp.length, 0);
    assert.match(delivered.telegram[0].body, /Pending claim/i);
  });

  it('never cold-messages a number that is not on Flizy', async () => {
    seed({ recipientOnFlizy: false });
    await sendAndConfirm(STRANGER_PHONE);

    assert.equal(delivered.whatsapp.length, 0);
    assert.equal(delivered.telegram.length, 0);
    assert.equal(
      (fake.db.tables.notifications || []).length,
      0,
      'nothing should be queued for an unknown number either'
    );
  });

  it('does not notify the sender about their own claim', async () => {
    seed({ recipientOnFlizy: true });
    await sendAndConfirm(RECIPIENT_PHONE);

    const toSender = [...delivered.whatsapp, ...delivered.telegram].filter(
      (d) => d.externalId === SENDER_WA
    );
    assert.equal(toSender.length, 0);
  });

  it('tells the sender the recipient was reached', async () => {
    seed({ recipientOnFlizy: true });
    const sent = await sendAndConfirm(RECIPIENT_PHONE);
    assert.ok(
      sent.some((m) => /just been notified/i.test(m)),
      `sender should learn the notice went out, got: ${JSON.stringify(sent)}`
    );
  });

  /**
   * from_wa_sender is rendered back to the recipient as "+<number>". Writing a
   * transfer key there would put "telegram:5566778899" through the phone
   * normalizer and store 5566778899, telling the recipient the money came from
   * a number that is not the sender's and may belong to someone else entirely.
   */
  it('never records a chat user id as the sender phone', async () => {
    seed({ recipientOnFlizy: true });

    const sent = [];
    const tgCtx = {
      channel: 'telegram',
      externalId: '5566778899',
      key: 'telegram:5566778899',
      raw: {},
      reply: async (text) => sent.push(text),
      // This Telegram user never shared a number
      resolveVerifiedPhone: async () => null,
      requestPhone: async () => {},
    };
    // Link the Telegram identity to a real site account so the send is allowed
    fake.db.tables.channel_identities.push({
      id: 'id-tg-sender',
      account_id: 'acc-sender',
      channel: 'telegram',
      external_id: '5566778899',
      phone_e164: null,
    });

    await router.handle(tgCtx, '/send 0.01 to ' + RECIPIENT_PHONE);
    await router.handle(tgCtx, 'confirm');

    assert.equal(claimHoldCalls.length, 1, 'the claim should still be held');
    assert.equal(
      claimHoldCalls[0].fromWaSender,
      null,
      'an unverified sender has no phone to record, so it must be null'
    );
  });

  it('does not let an account escrow money to its own other number', async () => {
    seed({ recipientOnFlizy: true });
    // Same account, second channel, different verified number
    fake.db.tables.channel_identities.push({
      id: 'id-sender-tg',
      account_id: 'acc-sender',
      channel: 'telegram',
      external_id: '4433221100',
      phone_e164: '2348055550000',
    });

    const sent = [];
    const ctx = senderCtx(sent);
    await router.handle(ctx, 'flizy send 0.01 to 2348055550000');

    assert.equal(claimHoldCalls.length, 0, 'must not plan a claim to yourself');
    assert.ok(
      sent.some((m) => /your own Flizy account/i.test(m)),
      `expected a self-send refusal, got: ${JSON.stringify(sent)}`
    );
  });

  it('queues instead of dropping when no process can deliver that channel', async () => {
    seed({ recipientOnFlizy: true, recipientChannels: ['whatsapp'] });
    const notify = require('../lib/notify');
    // Simulate the Telegram-only process: it cannot reach WhatsApp itself
    const restore = delivered.whatsapp;
    notify.registerChannelSender('whatsapp', async () => {
      throw new Error('no whatsapp session in this process');
    });

    await sendAndConfirm(RECIPIENT_PHONE);

    assert.equal(
      (fake.db.tables.notifications || []).length,
      1,
      'an undeliverable notice must land in the outbox, not vanish'
    );
    assert.equal(fake.db.tables.notifications[0].channel, 'whatsapp');

    notify.registerChannelSender('whatsapp', async (externalId, body) => {
      restore.push({ externalId, body });
    });
  });
});
