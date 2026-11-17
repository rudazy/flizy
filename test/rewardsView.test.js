/**
 * Rewards (R2): what an account sees of its rewards, in chat and on Account >
 * Rewards (lib/rewardsView.js, migration 20261117130000_reward_balance.sql).
 *
 * Covers: points are exact cents of reward; each entry named in words, never
 * with a share; the balance from the database, the latest entries newest
 * first, with whether there are more; a failed read throws; the chat reply and
 * its empty state; the command, the route, the slide and the migration.
 *
 * Run: node --test test/rewardsView.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const V = require('../lib/rewardsView');
const { isRewardsCommand, isFlizyCommandBody } = require('../lib/commands/parse');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ME = '11111111-1111-4111-8111-111111111111';
const ADA = '22222222-2222-4222-8222-222222222222';

/** The fake database, with reward_balance as the migration writes it. */
function world(entries, extra = {}) {
  const fake = createFakeSupabase({ reward_entries: entries, fee_ledger: [], accounts: [], ...extra });
  const rpc = fake.client.rpc.bind(fake.client);
  fake.client.rpc = async (name, args) => {
    if (name !== 'reward_balance') return rpc(name, args);
    const sum = fake.db.tables.reward_entries.filter((e) => e.account_id === args.p_account_id).reduce((t, e) => t + BigInt(e.usd_micro), 0n);
    return { data: Number(sum), error: null };
  };
  return fake;
}

const entry = (over) => ({ account_id: ME, kind: 'cashback', usd_micro: '1000', fee_ledger_id: 'f1', from_account_id: null, created_at: '2026-11-17T10:00:00.000Z', ...over });

describe('points', () => {
  it('one point is one cent of reward, exact to the micro-dollar', () => {
    for (const [micro, text] of [[0, '0'], [10000, '1'], ['12345', '1.2345'], [1000, '0.1'], [1, '0.0001'], [-2500, '-0.25'], [1230000, '123']]) {
      assert.equal(V.pointsText(micro), text, String(micro));
    }
  });

  it('each entry in words', () => {
    assert.equal(V.entryLabel({ kind: 'cashback' }, 'p2p'), 'Cashback on a payment');
    assert.equal(V.entryLabel({ kind: 'cashback' }, 'swap'), 'Cashback on a swap');
    assert.equal(V.entryLabel({ kind: 'referral' }, null, 'ada'), 'Referral reward: @ada');
    assert.equal(V.entryLabel({ kind: 'referral' }, null, undefined), 'Referral reward');
    assert.equal(V.entryLabel({ kind: 'merchant' }), 'Business reward');
    assert.equal(V.entryLabel({ kind: 'adjustment' }), 'Adjustment');
  });
});

describe('loading', () => {
  it('the balance from the database, the latest entries newest first, named, and whether there are more', async () => {
    // Seeded newest first: the fake does not sort; the query's order is checked below.
    const fake = world(
      [
        entry({ fee_ledger_id: 'f4', created_at: '2026-11-17T13:00:00.000Z' }),
        entry({ kind: 'merchant', usd_micro: '1500', fee_ledger_id: 'f3', created_at: '2026-11-17T12:00:00.000Z' }),
        entry({ kind: 'referral', usd_micro: '750', fee_ledger_id: 'f2', from_account_id: ADA, created_at: '2026-11-17T11:00:00.000Z' }),
        entry({ fee_ledger_id: 'f1', created_at: '2026-11-17T09:00:00.000Z' }),
        entry({ account_id: ADA, usd_micro: '999999' }),
      ],
      { fee_ledger: [{ id: 'f1', kind: 'p2p' }, { id: 'f4', kind: 'swap' }], accounts: [{ id: ADA, username: 'ada' }] }
    );
    const view = await V.loadRewards(fake.client, ME, { limit: 3 });
    assert.equal(view.points, '0.425');
    assert.deepEqual(view.entries.map((e) => [e.label, e.points]), [
      ['Cashback on a swap', '0.1'],
      ['Business reward', '0.15'],
      ['Referral reward: @ada', '0.075'],
    ]);
    assert.match(read('lib/rewardsView.js'), /\.eq\('account_id', accountId\)\s+\.order\('created_at', \{ ascending: false \}\)\s+\.limit\(limit \+ 1\)/);
    assert.equal(view.more, true);
    assert.equal((await V.loadRewards(fake.client, ME)).more, false);
    assert.deepEqual(await V.loadRewards(fake.client, '33333333-3333-4333-8333-333333333333'), { points: '0', entries: [], more: false });
  });

  it('a failed read throws instead of showing a wrong balance', async () => {
    const fake = world([entry()]);
    fake.client.rpc = async () => ({ data: null, error: { message: 'down' } });
    await assert.rejects(V.loadRewards(fake.client, ME), /down/);
    const fake2 = world([entry()]);
    const from = fake2.client.from.bind(fake2.client);
    fake2.client.from = (t) => {
      const q = from(t);
      if (t === 'fee_ledger') q.in = () => Promise.resolve({ data: null, error: { message: 'down' } });
      return q;
    };
    await assert.rejects(V.loadRewards(fake2.client, ME), /down/);
  });
});

describe('the chat reply', () => {
  const view = { points: '1.25', entries: Array.from({ length: 7 }, (_, i) => ({ at: '', label: `Entry ${i}`, points: i === 0 ? '-0.5' : '0.1' })), more: true };

  it('the balance, the latest five with their sign, the testnet note and the link', () => {
    const text = V.rewardsChatText(view, 'https://flizy.app');
    assert.match(text, /^Your rewards: 1\.25 points\n\nLatest:\n-0\.5 Entry 0\n\+0\.1 Entry 1\n/);
    assert.doesNotMatch(text, /Entry 5/);
    assert.match(text, /Points, not money, while Flizy is on testnet\.\nAll of them: https:\/\/flizy\.app\/dashboard\/account\?s=rewards$/);
  });

  it('with none yet, how to earn them; never a share', () => {
    const text = V.rewardsChatText({ points: '0', entries: [], more: false }, 'https://flizy.app');
    assert.match(text, /No rewards yet\.\nYou earn points on the fees you pay, when people you invite pay fees, and on your sales as a business\./);
    for (const t of [text, V.HOW_TO_EARN, V.TESTNET_NOTE]) assert.doesNotMatch(t, /%|percent|bps/i);
  });
});

describe('wiring', () => {
  it('rewards, reward and points are the command', () => {
    for (const t of ['rewards', 'Reward', 'points']) {
      assert.equal(isRewardsCommand(t), true, t);
      assert.equal(isFlizyCommandBody(t), true, t);
    }
    assert.equal(isRewardsCommand('rewards please'), false);
  });

  it('chat answers it for the linked site account, before the other commands', () => {
    const router = read('lib/router.js');
    assert.match(router, /if \(isRewardsCommand\(text\)\) \{\s+await handleRewards\(ctx, account\);/);
    const handler = router.slice(router.indexOf('async function handleRewards'));
    assert.ok(handler.indexOf('resolveLinkedSiteAccount(ctx, account)') < handler.indexOf('loadRewards(supabase, acc.id)'));
    assert.match(router, /\{ command: 'rewards', description: 'Wallet: your reward points' \}/);
  });

  it('the site reads the same rewards for the signed-in account only, on its own slide', () => {
    const route = read('web/app/api/account/rewards/route.ts');
    assert.match(route, /require\('\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/rewardsView'\)/);
    assert.ok(route.indexOf("{ status: 401 }") < route.indexOf('loadRewards(getSupabase(), accountId'));
    const page = read('web/app/dashboard/account/page.tsx');
    assert.match(page, /\{ id: 'rewards', label: 'Rewards' \}/);
    assert.match(page, /\{slide === 'rewards' \? <RewardsPanel \/> : null\}/);
    assert.match(read('web/components/RewardsPanel.tsx'), /fetch\('\/api\/account\/rewards', \{ cache: 'no-store' \}\)/);
  });
});

describe('the migration', () => {
  const sql = read('supabase/migrations/20261117130000_reward_balance.sql');

  it('the sum of the account\'s entries, 0 when none, service role only', () => {
    assert.match(sql, /select coalesce\(sum\(usd_micro\), 0\)::bigint\s+from public\.reward_entries\s+where account_id = p_account_id;/);
    assert.match(sql, /revoke all on function public\.reward_balance\(uuid\) from public, anon, authenticated;/);
    assert.match(sql, /raise exception 'reward_balance is callable by anon'/);
  });
});
