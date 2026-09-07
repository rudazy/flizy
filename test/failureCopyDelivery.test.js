/**
 * Markers are rendered at delivery, on both outbound paths.
 *
 * There are exactly two ways a message leaves Flizy, and each is the first
 * point that knows which channel it is leaving on:
 *
 *   - `reply()` in lib/commands/chat.js, for an answer to something typed.
 *   - `deliver()` in lib/notify.js, for a notification, which fans one body out
 *     to every channel an account has linked.
 *
 * The second is why this mechanism exists at all. A ctx-based helper picks the
 * *sender's* channel, and a notification is read by the recipient — possibly on
 * a different channel, possibly on two at once. There is no single correct
 * wording at the moment the body is composed, so it cannot be decided there.
 *
 * Run: node --test test/failureCopyDelivery.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { VECTOR_SECRET } = require('./helpers/derivationVector');

process.env.WALLET_DERIVATION_SECRET = VECTOR_SECRET;

let fake = createFakeSupabase();
mockSupabaseModule({ from: (table) => fake.client.from(table) });

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
    supabase: {
      from: (table) => fake.client.from(table),
      rpc: (name, args) => fake.client.rpc(name, args),
    },
    provider: { getCode: async () => '0x' },
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => `https://explorer.test/tx/${h}`,
    addressUrl: (a) => `https://explorer.test/address/${a}`,
    getOpsBalanceEth: async () => '1.0',
  },
};

const notify = require('../lib/notify');

const WA = '2348012345678';
const TG = '55501';

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [
      {
        id: 'acc-both',
        email: 'both@example.com',
        display_name: 'Both',
        username: 'both',
        balance_eth: 0,
        is_admin: false,
        agent_wallet_address: '0x1111111111111111111111111111111111111111',
      },
    ],
    channel_identities: [
      { id: 'i1', account_id: 'acc-both', channel: 'whatsapp', external_id: WA, phone_e164: WA },
      { id: 'i2', account_id: 'acc-both', channel: 'telegram', external_id: TG, phone_e164: null },
    ],
    notifications: [],
    link_codes: [],
    users: [],
    sessions: [],
    trusted_addresses: [],
  });
});

describe('the reply seam', () => {
  const { reply } = require('../lib/commands/chat');

  /**
   * Every reply in the product goes through this one function — nothing in
   * lib/ calls ctx.reply directly — so rendering here covers the whole reply
   * path. The engine copy under test is the real string from
   * lib/engine/policy.js.
   */
  const LOCKED = 'Session locked. Send:\n{{cmd:unlock your-pin}}';

  async function replied(channel) {
    let got = null;
    await reply({ channel, key: `${channel}:1`, reply: async (t) => { got = t; } }, LOCKED);
    return got;
  }

  it('renders the locked refusal in each channel own dialect', async () => {
    assert.equal(await replied('whatsapp'), 'Session locked. Send:\nflizy unlock your-pin');
    assert.equal(await replied('telegram'), 'Session locked. Send:\n/unlock your-pin');
  });
});

describe('one body, two channels, each rendered for itself', () => {
  it('sends the same notification in each channel own dialect', async () => {
    const seen = { whatsapp: [], telegram: [] };
    notify.registerChannelSender('whatsapp', async (id, body) => {
      seen.whatsapp.push({ id, body });
    });
    notify.registerChannelSender('telegram', async (id, body) => {
      seen.telegram.push({ id, body });
    });

    // Exactly what lib/handlers/claims.js composes: one body for the account.
    const result = await notify.notifyAccount(
      'acc-both',
      ['Someone sent you 0.01 ETH.', 'Receive it: {{cmd:claim}}'].join('\n')
    );

    assert.equal(result.delivered, 2, JSON.stringify(result));
    assert.equal(seen.whatsapp.length, 1);
    assert.equal(seen.telegram.length, 1);

    assert.match(seen.whatsapp[0].body, /Receive it: flizy claim$/);
    assert.match(seen.telegram[0].body, /Receive it: \/claim$/);

    // And neither carries a marker the reader would have to decode.
    assert.equal(seen.whatsapp[0].body.includes('{{cmd:'), false);
    assert.equal(seen.telegram[0].body.includes('{{cmd:'), false);
  });

  it('renders before queueing, so a message drained later is already correct', async () => {
    // A direct send that fails falls through to the outbox. The stored body has
    // to be already rendered: the process that drains it later only knows the
    // channel, not the marker's meaning.
    notify.registerChannelSender('telegram', async () => {
      throw new Error('telegram down');
    });

    const outcome = await notify.deliver({
      accountId: 'acc-both',
      channel: 'telegram',
      externalId: TG,
      body: 'Receive it: {{cmd:claim}}',
    });

    assert.equal(outcome, 'queued');
    const queued = fake.db.tables.notifications || [];
    assert.equal(queued.length, 1, 'nothing was queued');
    assert.equal(queued[0].body, 'Receive it: /claim');
  });
});
