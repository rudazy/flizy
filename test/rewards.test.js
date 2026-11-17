/**
 * Rewards (R1): the settings, the shares of a fee, and the worker that records
 * them once per fee (lib/rewards.js, migration 20261117120000_rewards.sql).
 *
 * Covers: off by default, needs a start time, refuses shares above the fee;
 * cashback and referral on person-to-person and swap fees, the business reward
 * and its referral on merchant fees, nothing on API payout fees; shares of the
 * net fee, the gross fee when gas is not known, nothing on a fee net of zero;
 * the business is the account paid, never the payer; a referral only for fees
 * settled once the invite was counted; a fee recorded once, before the start
 * time never; a failed read records nothing; and the migration's guards.
 *
 * Run: node --test test/rewards.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const R = require('../lib/rewards');

const START = '2026-11-17T00:00:00.000Z';
// Shares made up for the tests; the real ones are server settings only.
const SHARES = { REWARDS_CASHBACK_BPS: '400', REWARDS_REFERRAL_BPS: '300', REWARDS_MERCHANT_BPS: '800' };
const ON = { REWARDS_ENABLED: 'true', REWARDS_START_AT: START, ...SHARES };
const cfg = R.rewardsConfig(ON);

const PAYER = '11111111-1111-4111-8111-111111111111';
const INVITER = '22222222-2222-4222-8222-222222222222';
const SHOP = '33333333-3333-4333-8333-333333333333';
const SHOP_INVITER = '44444444-4444-4444-8444-444444444444';
const SHOP_WALLET = '0x' + 'ab'.repeat(20);
const quiet = { error() {} };

/** A charged fee row. */
function fee(over = {}) {
  return {
    id: 'f-' + Math.random().toString(16).slice(2, 10),
    kind: 'p2p',
    state: 'charged',
    account_id: PAYER,
    source_kind: 'transfer',
    source_id: '55555555-5555-4555-8555-555555555555',
    fee_usd_micro: '20000',
    net_usd_micro: '15000',
    settled_at: '2026-11-17T10:00:00.000Z',
    rewards_at: null,
    ...over,
  };
}

/**
 * The fake database, with record_fee_rewards as the migration writes it: the
 * fee is marked done and its entries written together, once.
 */
function world(seed = {}) {
  const fake = createFakeSupabase({ fee_ledger: [], reward_entries: [], transfers: [], invite_attributions: [], ...seed });
  const calls = [];
  const rpc = fake.client.rpc.bind(fake.client);
  fake.client.rpc = async (name, args) => {
    if (name !== 'record_fee_rewards') return rpc(name, args);
    calls.push(args);
    const row = fake.db.tables.fee_ledger.find((f) => f.id === args.p_fee_id);
    if (!row || row.state !== 'charged' || row.rewards_at) return { data: false, error: null };
    for (const e of args.p_entries) {
      if (!['cashback', 'referral', 'merchant'].includes(e.kind)) return { data: null, error: { message: 'bad kind' } };
    }
    row.rewards_at = new Date().toISOString();
    for (const e of args.p_entries) {
      if (fake.db.tables.reward_entries.some((r) => r.fee_ledger_id === row.id && r.kind === e.kind)) continue;
      fake.db.tables.reward_entries.push({ ...e, fee_ledger_id: row.id });
    }
    return { data: true, error: null };
  };
  return { ...fake, calls, entries: () => fake.db.tables.reward_entries.map((e) => [e.kind, e.account_id, e.usd_micro, e.from_account_id]) };
}

const counted = (invitee, inviter, at = '2026-11-16T00:00:00.000Z') => ({ invitee_account_id: invitee, inviter_account_id: inviter, counted_at: at });

describe('settings', () => {
  it('off by default, with no shares in code', () => {
    const c = R.rewardsConfig({});
    assert.deepEqual([c.enabled, c.startAt, c.cashbackBps, c.referralBps, c.merchantBps], [false, null, 0, 0, 0]);
    assert.deepEqual([R.rewardsConfig(ON).cashbackBps, R.rewardsConfig(ON).referralBps, R.rewardsConfig(ON).merchantBps], [400, 300, 800]);
  });

  it('on needs a start time; a malformed setting or shares above the fee fail at start', () => {
    assert.equal(R.rewardsConfig(ON).startAt, START);
    for (const env of [
      { REWARDS_ENABLED: 'true', ...SHARES },
      { ...ON, REWARDS_CASHBACK_BPS: '' },
      { ...ON, REWARDS_REFERRAL_BPS: undefined },
      { ...ON, REWARDS_MERCHANT_BPS: ' ' },
      { ...ON, REWARDS_START_AT: 'tomorrow' },
      { ...ON, REWARDS_START_AT: '2026-11-17' },
      { ...ON, REWARDS_CASHBACK_BPS: '5.5' },
      { ...ON, REWARDS_CASHBACK_BPS: '-1' },
      { ...ON, REWARDS_MERCHANT_BPS: '10001' },
      { ...ON, REWARDS_CASHBACK_BPS: '6000', REWARDS_REFERRAL_BPS: '5000' },
      { ...ON, REWARDS_MERCHANT_BPS: '9800', REWARDS_REFERRAL_BPS: '300' },
    ]) {
      assert.throws(() => R.rewardsConfig(env), Error, JSON.stringify(env));
    }
  });

  it('the worker runs nothing while rewards are off', () => {
    assert.equal(R.startRewardsWorker({ supabase: createFakeSupabase().client, env: {} }), null);
  });
});

describe('the shares of a fee', () => {
  it('a person-to-person or swap fee: cashback to the payer and a referral to its inviter, of the net fee', () => {
    for (const kind of ['p2p', 'swap']) {
      assert.deepEqual(R.planFeeRewards(fee({ kind }), { inviter: INVITER }, cfg), [
        { account_id: PAYER, kind: 'cashback', usd_micro: '600', from_account_id: null },
        { account_id: INVITER, kind: 'referral', usd_micro: '450', from_account_id: PAYER },
      ]);
    }
  });

  it('a merchant fee: the business reward to the business and the referral to its inviter; the payer earns nothing', () => {
    assert.deepEqual(R.planFeeRewards(fee({ kind: 'merchant' }), { business: SHOP, inviter: SHOP_INVITER }, cfg), [
      { account_id: SHOP, kind: 'merchant', usd_micro: '1200', from_account_id: null },
      { account_id: SHOP_INVITER, kind: 'referral', usd_micro: '450', from_account_id: SHOP },
    ]);
    assert.deepEqual(R.planFeeRewards(fee({ kind: 'merchant' }), { business: null }, cfg), []);
  });

  it('nothing on an API payout fee, a fee with no payer, or a fee net of zero; the gross fee when gas is not known', () => {
    assert.deepEqual(R.planFeeRewards(fee({ kind: 'api_payout' }), {}, cfg), []);
    assert.deepEqual(R.planFeeRewards(fee({ account_id: null }), {}, cfg), []);
    assert.deepEqual(R.planFeeRewards(fee({ net_usd_micro: '-500' }), {}, cfg), []);
    assert.equal(R.rewardBase(fee({ net_usd_micro: null })), 20000n);
    assert.equal(R.rewardBase(fee({ net_usd_micro: '-500' })), 0n);
    assert.deepEqual(R.planFeeRewards(fee({ net_usd_micro: null }), {}, cfg), [{ account_id: PAYER, kind: 'cashback', usd_micro: '800', from_account_id: null }]);
  });

  it('rounds down, drops a zero share, and never refers an account to itself', () => {
    assert.deepEqual(R.planFeeRewards(fee({ net_usd_micro: '24' }), { inviter: INVITER }, cfg), []);
    assert.deepEqual(R.planFeeRewards(fee({ net_usd_micro: '49' }), { inviter: PAYER }, cfg), [{ account_id: PAYER, kind: 'cashback', usd_micro: '1', from_account_id: null }]);
  });
});

describe('the worker', () => {
  it('records each fee once, with its entries, and a second run records nothing', async () => {
    const w = world({ fee_ledger: [fee({ id: 'f1' })], invite_attributions: [counted(PAYER, INVITER)] });
    assert.deepEqual(await R.accrueRewards({ supabase: w.client, cfg, log: quiet }), { recorded: 1, skipped: 0, failed: 0 });
    assert.deepEqual(w.entries(), [['cashback', PAYER, '600', null], ['referral', INVITER, '450', PAYER]]);
    assert.deepEqual(await R.accrueRewards({ supabase: w.client, cfg, log: quiet }), { recorded: 0, skipped: 0, failed: 0 });
    assert.equal(w.calls.length, 1);
  });

  it('only charged fees settled from the start time; pending, waived and older fees are left alone', async () => {
    const w = world({
      fee_ledger: [
        fee({ id: 'old', settled_at: '2026-11-16T23:59:59.000Z' }),
        fee({ id: 'pending', state: 'pending', settled_at: null }),
        fee({ id: 'waived', state: 'waived' }),
        fee({ id: 'new' }),
      ],
    });
    await R.accrueRewards({ supabase: w.client, cfg, log: quiet });
    assert.deepEqual(w.calls.map((c) => c.p_fee_id), ['new']);
  });

  it('a merchant fee rewards the account the payment went to, not the payer', async () => {
    const t = { id: '66666666-6666-4666-8666-666666666666', to_address: SHOP_WALLET.toUpperCase().replace('0X', '0x') };
    const w = world({
      accounts: [{ id: SHOP, agent_wallet_address: SHOP_WALLET }],
      transfers: [t],
      fee_ledger: [fee({ id: 'm1', kind: 'merchant', source_id: t.id })],
      invite_attributions: [counted(PAYER, INVITER), counted(SHOP, SHOP_INVITER)],
    });
    await R.accrueRewards({ supabase: w.client, cfg, log: quiet });
    assert.deepEqual(w.entries(), [['merchant', SHOP, '1200', null], ['referral', SHOP_INVITER, '450', SHOP]]);
  });

  it('a merchant fee whose business cannot be found, or is the payer, is recorded with nothing', async () => {
    const t = { id: '77777777-7777-4777-8777-777777777777', to_address: SHOP_WALLET };
    const w = world({
      accounts: [{ id: PAYER, agent_wallet_address: SHOP_WALLET }],
      transfers: [t],
      fee_ledger: [fee({ id: 'm2', kind: 'merchant', source_id: t.id }), fee({ id: 'm3', kind: 'merchant', source_id: '88888888-8888-4888-8888-888888888888' })],
    });
    assert.deepEqual(await R.accrueRewards({ supabase: w.client, cfg, log: quiet }), { recorded: 2, skipped: 0, failed: 0 });
    assert.deepEqual(w.entries(), []);
  });

  it('a referral only for fees settled once the invite was counted; an uncounted invite earns nothing', async () => {
    const w = world({
      fee_ledger: [fee({ id: 'before', settled_at: '2026-11-17T08:00:00.000Z' }), fee({ id: 'after', settled_at: '2026-11-17T12:00:00.000Z' })],
      invite_attributions: [counted(PAYER, INVITER, '2026-11-17T09:00:00.000Z')],
    });
    await R.accrueRewards({ supabase: w.client, cfg, log: quiet });
    const referrals = w.db.tables.reward_entries.filter((e) => e.kind === 'referral').map((e) => e.fee_ledger_id);
    assert.deepEqual(referrals, ['after']);

    const w2 = world({ fee_ledger: [fee({ id: 'f2' })], invite_attributions: [{ invitee_account_id: PAYER, inviter_account_id: INVITER, counted_at: null }] });
    await R.accrueRewards({ supabase: w2.client, cfg, log: quiet });
    assert.deepEqual(w2.entries(), [['cashback', PAYER, '600', null]]);
  });

  it('a failed read records nothing, so no fee loses its referral or its business', async () => {
    for (const table of ['invite_attributions', 'transfers']) {
      const w = world({ fee_ledger: [fee({ id: 'f3', kind: table === 'transfers' ? 'merchant' : 'p2p' })] });
      const from = w.client.from.bind(w.client);
      w.client.from = (name) => {
        if (name !== table) return from(name);
        const q = from(name);
        q.in = () => Promise.resolve({ data: null, error: { message: 'down' } });
        return q;
      };
      await assert.rejects(R.accrueRewards({ supabase: w.client, cfg, log: quiet }), /down/);
      assert.equal(w.calls.length, 0, table);
    }
  });

  it('a fee whose record fails is counted and left for the next run', async () => {
    const w = world({ fee_ledger: [fee({ id: 'f4' }), fee({ id: 'f5' })] });
    const rpc = w.client.rpc;
    w.client.rpc = async (name, args) => (args.p_fee_id === 'f4' ? { data: null, error: { message: 'boom' } } : rpc(name, args));
    assert.deepEqual(await R.accrueRewards({ supabase: w.client, cfg, log: quiet }), { recorded: 1, skipped: 0, failed: 1 });
    assert.equal(w.db.tables.fee_ledger.find((f) => f.id === 'f4').rewards_at, null);
  });

  it('started from the bot, next to the reconciler', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.match(index, /const \{ startRewardsWorker \} = require\('\.\/lib\/rewards'\);/);
    assert.match(index, /startReconciler\(\{ supabase, provider \}\);[\s\S]{0,300}startRewardsWorker\(\{ supabase \}\);/);
  });
});

describe('the migration', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261117120000_rewards.sql'), 'utf8');

  it('one entry per fee and kind, positive unless an adjustment, service role only', () => {
    assert.match(sql, /constraint reward_entries_fee_kind_unique unique \(fee_ledger_id, kind\)/);
    assert.match(sql, /check \(kind = 'adjustment' or \(fee_ledger_id is not null and usd_micro > 0\)\)/);
    assert.match(sql, /alter table public\.reward_entries enable row level security;/);
    assert.match(sql, /revoke all on function public\.record_fee_rewards\(uuid, jsonb\) from public, anon, authenticated;/);
  });

  it('a fee is marked done in the same statement as its entries, only from charged and not yet done', () => {
    const body = sql.slice(sql.indexOf('create or replace function public.record_fee_rewards'));
    const mark = body.indexOf('where id = p_fee_id and state = \'charged\' and rewards_at is null;');
    assert.ok(mark > 0 && mark < body.indexOf('insert into public.reward_entries'));
    assert.match(body, /if not found then\s+return false;/);
    assert.match(body, /e\.kind not in \('cashback', 'referral', 'merchant'\)/);
    assert.match(sql, /raise exception 'record_fee_rewards is callable by anon'/);
  });
});
