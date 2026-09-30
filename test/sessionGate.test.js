/**
 * The money policies read the unlock state themselves.
 *
 * They are handed who is acting (account, channel, external id) and look the
 * session up. Nothing the caller says about being unlocked is consulted, so a
 * new entry point cannot pass the check by claiming it. A missing context, an
 * unknown account and a failed read all deny. No PIN set still means no unlock
 * prompt, the rule chat has always had.
 *
 * Run: node --test test/sessionGate.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

const TG = '778899127';
const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const past = () => new Date(0).toISOString();

let fake;
let failReads = false;

mockSupabaseModule({
  from: (table) => {
    if (failReads) throw new Error('database unreachable');
    return fake.client.from(table);
  },
});

const { sessionGate } = require('../lib/session');
const { createSendIntent, createSwapIntent } = require('../lib/engine/intent');
const {
  evaluateSendPolicy,
  evaluateSwapPolicy,
  evaluateClaimHoldPolicy,
} = require('../lib/engine/policy');
const { getDexConfig } = require('../lib/dex');

function seed({ pin = true, session = null } = {}) {
  fake = createFakeSupabase({
    accounts: [{ id: 'acc-1', unlock_pin_hash: pin ? 'pin-hash-present' : null }],
    sessions: session
      ? [{ account_id: 'acc-1', channel: 'telegram', external_id: TG, ...session }]
      : [],
  });
}

const actor = (over = {}) => ({
  accountId: 'acc-1',
  channel: 'telegram',
  externalId: TG,
  isAdmin: false,
  ...over,
});

beforeEach(() => {
  failReads = false;
  seed();
});

describe('sessionGate', () => {
  it('denies a missing account, channel or external id', async () => {
    for (const over of [{ accountId: null }, { channel: undefined }, { externalId: '' }]) {
      const gate = await sessionGate(actor(over), { requireUnlock: true });
      assert.deepEqual(gate, { ok: false, reason: 'no_context' }, JSON.stringify(over));
    }
    assert.deepEqual(await sessionGate(undefined), { ok: false, reason: 'no_context' });
  });

  it('denies a channel it does not know', async () => {
    const gate = await sessionGate(actor({ channel: 'carrier-pigeon' }), { requireUnlock: true });
    assert.deepEqual(gate, { ok: false, reason: 'no_context' });
  });

  it('denies an account it cannot find', async () => {
    const gate = await sessionGate(actor({ accountId: 'acc-missing' }), { requireUnlock: true });
    assert.deepEqual(gate, { ok: false, reason: 'no_context' });
  });

  it('does not prompt when no PIN is set', async () => {
    seed({ pin: false, session: { is_locked: false, expires_at: past() } });
    assert.deepEqual(await sessionGate(actor(), { requireUnlock: true }), { ok: true });
  });

  it('allows a PIN account with no session row, as chat always has', async () => {
    assert.deepEqual(await sessionGate(actor(), { requireUnlock: true }), { ok: true });
  });

  it('allows a live unlocked session', async () => {
    seed({ session: { is_locked: false, expires_at: future() } });
    assert.deepEqual(await sessionGate(actor(), { requireUnlock: true }), { ok: true });
  });

  it('denies a locked session and an expired one', async () => {
    seed({ session: { is_locked: true, expires_at: future() } });
    assert.deepEqual(await sessionGate(actor(), { requireUnlock: true }), {
      ok: false,
      reason: 'session_locked',
    });
    seed({ session: { is_locked: false, expires_at: past() } });
    assert.deepEqual(await sessionGate(actor(), { requireUnlock: true }), {
      ok: false,
      reason: 'session_locked',
    });
  });

  it('lets an admin and an unlock-off config through, but only with a context', async () => {
    seed({ session: { is_locked: true, expires_at: future() } });
    assert.deepEqual(await sessionGate(actor({ isAdmin: true }), { requireUnlock: true }), { ok: true });
    assert.deepEqual(await sessionGate(actor(), { requireUnlock: false }), { ok: true });
    assert.equal((await sessionGate(actor({ isAdmin: true, channel: null }))).ok, false);
  });

  it('denies when the state cannot be read', async () => {
    failReads = true;
    const gate = await sessionGate(actor(), { requireUnlock: true });
    assert.deepEqual(gate, { ok: false, reason: 'session_unavailable' });
  });
});

describe('the policies use it', () => {
  const TO = '0x1111111111111111111111111111111111111111';
  const send = (a) =>
    evaluateSendPolicy(createSendIntent({ actor: a, amountEth: '0.01', toAddress: TO }), {
      enforceTrusted: false,
      requireUnlock: true,
      skipDailyLimit: true,
    });

  it('send: missing context is denied, even when the caller claims to be unlocked', async () => {
    const r = await send({ accountId: 'acc-1', sessionUnlocked: true, hasPin: false });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'no_context');
  });

  it('send: a locked session is denied, whatever the caller says', async () => {
    seed({ session: { is_locked: true, expires_at: future() } });
    const r = await send(actor({ sessionUnlocked: true }));
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'session_locked');
  });

  it('send: an unlocked session is allowed', async () => {
    seed({ session: { is_locked: false, expires_at: future() } });
    const r = await send(actor());
    assert.equal(r.decision, 'ALLOW_WITH_CONFIRM');
    assert.equal(r.checks.sessionOk, true);
  });

  it('swap: missing context and a locked session are denied', async () => {
    const swap = (a) =>
      evaluateSwapPolicy(
        createSwapIntent({
          actor: a,
          amountIn: '0.01',
          routerAddress: getDexConfig('giwa_sepolia').feeRouter,
        }),
        { requireUnlock: true }
      );
    assert.equal((await swap({ accountId: 'acc-1', sessionUnlocked: true })).reason, 'no_context');
    seed({ session: { is_locked: true, expires_at: future() } });
    assert.equal((await swap(actor())).reason, 'session_locked');
  });

  it('claim hold: missing context is denied', async () => {
    const r = await evaluateClaimHoldPolicy(
      createSendIntent({ actor: { accountId: 'acc-1' }, amountEth: '0.01', toAddress: null }),
      { requireUnlock: true, skipDailyLimit: true }
    );
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'no_context');
  });
});
