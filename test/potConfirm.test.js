/**
 * A pot payment is checked again at CONFIRM.
 *
 * Paying a pot skips the trusted list, so the pot is what the plan was checked
 * against: open, and owned by the wallet the plan pays. Either can change while
 * the plan waits for its CONFIRM, and either change stops the payment.
 *
 * Run: node --test test/potConfirm.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');
const { unlockedSession, PIN_HASH_PRESENT } = require('./helpers/unlockedChat');

let fake = createFakeSupabase();
let failPots = false;
mockSupabaseModule({
  from: (table) => {
    if (failPots && table === 'pots') throw new Error('database unreachable');
    return fake.client.from(table);
  },
});

const { recheckAtConfirm } = require('../lib/engine/policy');

const TG = '778899140';
const OWNER_WALLET = '0x7777777777777777777777777777777777777777';
const actor = { accountId: 'acc-payer', channel: 'telegram', externalId: TG };
const plan = (to = OWNER_WALLET) => ({ potId: 'pot-1', route: { toAddress: to }, policyChecks: { trustedEnforced: false } });

beforeEach(() => {
  failPots = false;
  fake = createFakeSupabase({
    accounts: [
      { id: 'acc-payer', unlock_pin_hash: PIN_HASH_PRESENT },
      { id: 'acc-owner', agent_wallet_address: OWNER_WALLET },
    ],
    sessions: [unlockedSession('acc-payer', 'telegram', TG)],
    pots: [{ id: 'pot-1', code: '123456', owner_account_id: 'acc-owner', status: 'open', name: 'Trip' }],
  });
});

describe('a pot at CONFIRM', () => {
  it('still open and paying its owner: goes ahead', async () => {
    assert.deepEqual(await recheckAtConfirm(actor, plan(), { requireUnlock: true }), { ok: true });
  });

  it('closed since the plan was made: stops', async () => {
    fake.db.tables.pots[0].status = 'closed';
    const r = await recheckAtConfirm(actor, plan(), { requireUnlock: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'pot_closed');
    assert.match(r.message, /That pot is closed/);
  });

  it('gone: stops', async () => {
    fake.db.tables.pots.length = 0;
    assert.equal((await recheckAtConfirm(actor, plan(), { requireUnlock: true })).reason, 'pot_closed');
  });

  it('paying a wallet the owner no longer has: stops', async () => {
    const r = await recheckAtConfirm(actor, plan('0x8888888888888888888888888888888888888888'), { requireUnlock: true });
    assert.equal(r.reason, 'pot_moved');
  });

  it('unreadable: stops rather than sending', async () => {
    failPots = true;
    const r = await recheckAtConfirm(actor, plan(), { requireUnlock: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'pot_unavailable');
  });
});
