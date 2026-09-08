/**
 * A bill from creation to settled, and the two states it could not express.
 *
 * The bug this starts from: `listOutgoingRequests` returns pending rows only,
 * and `formatRequestsMenu` derived a bill's progress from whatever rows it was
 * handed. So the one branch that increments `paid` could never fire, and the
 * bill appeared to shrink as people settled -- "0 of 3" became "0 of 2" became
 * "0 of 1". The organiser's only view of who still owed them was structurally
 * incapable of showing progress.
 *
 * `test/splitBill.test.js` proved `summarizeBills` correct the whole time, by
 * calling it with a hand-built array. Third time that shape of gap has bitten:
 * the pure function is right and nothing checks what the caller feeds it. So
 * these tests go through the router.
 *
 * Run: node --test test/billLifecycle.test.js
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
    chain: { id: 'giwa_sepolia', name: 'GIWA Sepolia', chainId: 91342, nativeSymbol: 'ETH', rpcUrl: 'http://localhost:0' },
    supabase: { from: (t) => fake.client.from(t), rpc: (n, a) => fake.client.rpc(n, a) },
    provider: {},
    opsWallet: { address: '0x3333333333333333333333333333333333333333' },
    escrowWallet: { address: '0x4444444444444444444444444444444444444444' },
    txUrl: (h) => h,
    addressUrl: (a) => a,
    getOpsBalanceEth: async () => '1.0',
  },
};

const router = require('../lib/router');
const {
  summarizeBills,
  billProgressLine,
  requestRemainingEth,
  requestIsSettled,
  formatRequestReminderNotice,
} = require('../lib/paymentRequests');

const ORG = 'acc-org';
const ORG_WA = '2348012345678';

const acct = (id, u, a) => ({
  id, username: u, email: `${u}@e.com`, display_name: u, balance_eth: 0,
  is_admin: false, email_verified: true, agent_wallet_address: a,
});

async function org(text) {
  const sent = [];
  await router.handle(
    {
      channel: 'whatsapp', externalId: ORG_WA, key: `whatsapp:${ORG_WA}`, raw: {},
      reply: async (t) => sent.push(t),
      resolveVerifiedPhone: async () => null,
      requestPhone: async () => {},
    },
    text
  );
  return sent.join('\n');
}

const rows = () => fake.db.tables.payment_requests || [];

beforeEach(() => {
  fake = createFakeSupabase({
    accounts: [
      acct(ORG, 'whuffi', '0x1111111111111111111111111111111111111111'),
      acct('acc-a', 'ludarep', '0x2222222222222222222222222222222222222222'),
      acct('acc-b', 'jayne', '0x3333333333333333333333333333333333333333'),
    ],
    channel_identities: [
      { id: 'i1', account_id: ORG, channel: 'whatsapp', external_id: ORG_WA, phone_e164: ORG_WA },
    ],
    payment_requests: [], notifications: [], pots: [], transfers: [], pay_codes: [],
    link_codes: [], users: [], sessions: [], trusted_addresses: [], account_emails: [],
  });
});

describe('a bill reports progress over every share, not the unpaid ones', () => {
  it('counts a paid share as paid instead of losing it', async () => {
    await org('flizy split 0.03 with ludarep jayne for dinner');
    assert.match(await org('flizy requests'), /dinner: 0 of 2 paid, 2 still open/);

    rows()[0].status = 'paid';
    // The old code derived the summary from pending rows only, so this read
    // "0 of 1 paid": the settled share vanished and the bill shrank.
    assert.match(await org('flizy requests'), /dinner: 1 of 2 paid, 1 still open/);
  });

  it('names a declined share rather than silently dropping it', async () => {
    await org('flizy split 0.03 with ludarep jayne for dinner');
    rows()[0].status = 'paid';
    rows()[1].status = 'declined';
    const seen = await org('flizy requests');
    assert.match(seen, /dinner: 1 of 2 paid, 1 declined/);
  });

  it('still answers once every share is settled and no rows are open', async () => {
    await org('flizy split 0.03 with ludarep jayne for dinner');
    rows()[0].status = 'paid';
    rows()[1].status = 'paid';
    // "Did everyone pay me" is exactly when the organiser asks, and the
    // summary used to disappear at that moment.
    assert.match(await org('flizy requests'), /dinner: 2 of 2 paid/);
  });

  it('names the payer by account, not as a phone it does not have', async () => {
    await org('flizy split 0.03 with ludarep jayne for dinner');
    const seen = await org('flizy requests');
    assert.match(seen, /@ludarep/);
    assert.doesNotMatch(seen, /\+\?/, 'account-addressed rows rendered as a phone');
  });
});

describe('every share lands in exactly one bucket', () => {
  const bill = (statuses) =>
    summarizeBills(statuses.map((s) => ({ bill_id: 'b', bill_note: 'x', status: s })))[0];

  it('adds up', () => {
    const b = bill(['paid', 'declined', 'cancelled', 'pending']);
    assert.equal(b.total, 4);
    assert.equal(b.paid + b.declined + b.cancelled + b.open, b.total);
  });

  it('says nothing about the buckets that are empty', () => {
    assert.equal(billProgressLine(bill(['paid', 'paid'])), '2 of 2 paid');
  });
});

/**
 * Money arithmetic. The first version of requestRemainingEth used Number() and
 * reported 0.03 minus 0.01 as 0.019999999999999997, which would leave a request
 * one wei short of settled forever.
 */
describe('what is left to pay is exact', () => {
  it('subtracts without float error', () => {
    assert.equal(requestRemainingEth({ amount_eth: '0.03', paid_amount_eth: '0.01' }), '0.02');
  });

  it('is exact at one wei', () => {
    assert.equal(
      requestRemainingEth({ amount_eth: '0.000000000000000003', paid_amount_eth: '0.000000000000000001' }),
      '0.000000000000000002'
    );
  });

  it('never goes below zero', () => {
    assert.equal(requestRemainingEth({ amount_eth: '0.01', paid_amount_eth: '0.05' }), '0');
  });

  it('settles only when the whole ask has landed', () => {
    assert.equal(requestIsSettled({ amount_eth: '0.03', paid_amount_eth: '0.029' }), false);
    assert.equal(requestIsSettled({ amount_eth: '0.03', paid_amount_eth: '0.03' }), true);
  });
});

/**
 * Partial pay is answered with a bare amount, and a bare amount is not a
 * command. It routed and was tested here for a whole slice while no user could
 * reach it, because the WhatsApp gate is a separate list from the router and
 * these tests call the router directly. Same gap as the currency work; this is
 * the assertion that would have caught it.
 */
describe('a bare amount wakes the bot only while a pay prompt is open', () => {
  const { pendingClaimMenus } = require('../lib/commands/pending');
  const wa = { channel: 'whatsapp', key: 'whatsapp:gate' };
  const open = (mode) =>
    pendingClaimMenus.set(wa.key, {
      mode,
      awaitConfirmId: 'req-1',
      requests: [{ id: 'req-1' }],
      createdAt: Date.now(),
    });

  it('ignores an amount when nothing is being asked', () => {
    pendingClaimMenus.delete(wa.key);
    assert.equal(router.isFlizyCommand(wa, '0.01'), false, 'chatter became a command');
  });

  it('takes one while a request is waiting to be paid', () => {
    open('pay_request');
    assert.equal(router.isFlizyCommand(wa, '0.01'), true);
    assert.equal(router.isFlizyCommand(wa, 'flizy 0.01'), true);
    pendingClaimMenus.delete(wa.key);
  });

  it('still ignores ordinary words while that prompt is open', () => {
    open('pay_request');
    assert.equal(router.isFlizyCommand(wa, 'hello'), false);
    pendingClaimMenus.delete(wa.key);
  });

  it('does not take one for a menu an amount cannot answer', () => {
    // Cancelling is a numbered choice, not an amount, so waking here would only
    // turn chatter into commands.
    open('cancel_request');
    assert.equal(router.isFlizyCommand(wa, '0.01'), false);
    pendingClaimMenus.delete(wa.key);
  });
});

describe('the reminder', () => {
  it('says who is waiting and how much is left', () => {
    const t = formatRequestReminderNotice({ byLabel: '@whuffi', amountEth: '0.02', billNote: 'dinner' });
    assert.match(t, /@whuffi is still waiting on 0\.02 ETH/);
    assert.match(t, /Split: dinner/);
    assert.match(t, /\{\{cmd:pay\}\}/);
  });

  it('refuses to nudge when nothing is owed', async () => {
    assert.match(await org('flizy remind'), /Nothing to remind about/);
  });

  it('nudges an open request and reports who was reached', async () => {
    await org('flizy split 0.03 with ludarep jayne for dinner');
    const said = await org('flizy remind');
    assert.match(said, /Reminded 2 people/);
    assert.match(said, /@ludarep/);
  });

  it('will not nudge the same request twice in a row', async () => {
    await org('flizy split 0.03 with ludarep jayne for dinner');
    await org('flizy remind');
    // The limit lives in the row, so it survives anything that restarts the bot.
    assert.match(await org('flizy remind'), /reminded recently/i);
  });
});
