/**
 * Rewards (R3): the private rewards dashboard (web/lib/rewardsAdmin.ts,
 * web/lib/rewardsAdminData.ts, web/app/dashboard/admin/rewards,
 * /api/admin/rewards, web/components/RewardsDashboard.tsx).
 *
 * Covers: fees by the week they settled and rewards by the week they were
 * recorded, in dollars from micro-USD; net fees fall back to the gross fee;
 * the share, what Flizy kept, and the earners; without team leaves out both
 * the fees and the rewards of the excluded accounts; the top earners; the CSV;
 * admins only, never indexed; the reads; and the traction dashboard's own
 * cards and tables reused.
 *
 * Run: node --test test/rewardsAdmin.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeSupabase } = require('./helpers/fakeSupabase');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
let M;
let D;
let U;
before(async () => {
  M = await import('../web/lib/rewardsAdmin.ts');
  D = await import('../web/lib/rewardsAdminData.ts');
  U = await import('../web/lib/usdText.ts');
});

const ADA = 'a';
const BEN = 'b';
const TEAM = 't';
// Monday 2026-11-09 and Monday 2026-11-16; now is Wednesday 2026-11-18.
const NOW = Date.parse('2026-11-18T12:00:00.000Z');

function input() {
  return {
    now: NOW,
    fees: [
      { accountId: ADA, feeMicro: 20000, netMicro: 15000, at: '2026-11-10T10:00:00.000Z' },
      { accountId: BEN, feeMicro: 20000, netMicro: null, at: '2026-11-17T10:00:00.000Z' },
      { accountId: TEAM, feeMicro: 50000, netMicro: 40000, at: '2026-11-17T11:00:00.000Z' },
      { accountId: ADA, feeMicro: 10000, netMicro: 8000, at: null },
    ],
    rewards: [
      { accountId: ADA, kind: 'cashback', micro: 750, at: '2026-11-10T10:01:00.000Z' },
      { accountId: BEN, kind: 'referral', micro: 750, at: '2026-11-10T10:01:00.000Z' },
      { accountId: BEN, kind: 'cashback', micro: 1000, at: '2026-11-17T10:01:00.000Z' },
      { accountId: ADA, kind: 'merchant', micro: 4000, at: '2026-11-17T10:02:00.000Z' },
      { accountId: TEAM, kind: 'cashback', micro: 2000, at: '2026-11-17T11:01:00.000Z' },
      { accountId: ADA, kind: 'adjustment', micro: -500, at: '2026-11-17T12:00:00.000Z' },
    ],
    excluded: [TEAM],
  };
}

describe('the figures', () => {
  it('by week, in dollars: fees by when they settled, rewards by when they were recorded', () => {
    const r = M.computeRewardsAdmin(input(), { exclude: true });
    assert.deepEqual(r.weeks.map((w) => [w.week_start, w.partial]), [['2026-11-09', false], ['2026-11-16', true]]);
    const [w1, w2] = r.weeks;
    assert.deepEqual([w1.fees_charged, w1.fees_usd, w1.fees_net_usd, w1.cashback_usd, w1.referral_usd, w1.rewards_usd], [1, 0.02, 0.015, 0.00075, 0.00075, 0.0015]);
    assert.equal(w1.reward_share, 0.1);
    assert.equal(w1.kept_usd, 0.0135);
    // The gross fee where gas is not known; an adjustment counts in the total.
    assert.deepEqual([w2.fees_charged, w2.fees_net_usd, w2.business_usd, w2.adjustment_usd, w2.rewards_usd], [1, 0.02, 0.004, -0.0005, 0.0045]);
    assert.deepEqual([w1.accounts_rewarded, w1.referrers, w2.businesses_rewarded], [2, 1, 1]);
    assert.deepEqual(r.totals, { fees_net_usd: 0.035, rewards_usd: 0.006 });
  });

  it('without team leaves out the fees and the rewards of the excluded accounts; everyone has them', () => {
    const everyone = M.computeRewardsAdmin(input(), { exclude: false });
    assert.deepEqual([everyone.weeks[1].fees_charged, everyone.weeks[1].rewards_usd], [2, 0.0065]);
    assert.deepEqual(everyone.top.map((t) => t.accountId), [ADA, TEAM, BEN]);
    const without = M.computeRewardsAdmin(input(), { exclude: true });
    assert.deepEqual(without.top.map((t) => t.accountId), [ADA, BEN]);
  });

  it('the top earners with what they earned it for', () => {
    const [ada, ben] = M.computeRewardsAdmin(input(), { exclude: true }).top;
    assert.deepEqual(ada, { accountId: ADA, total: 0.00425, cashback: 0.00075, referral: 0, business: 0.004 });
    assert.deepEqual(ben, { accountId: BEN, total: 0.00175, cashback: 0.001, referral: 0.00075, business: 0 });
  });

  it('Monday 00:00 starts the new week; a referrer counts once a week; nobody with nothing to show is a top earner', () => {
    const r = M.computeRewardsAdmin(
      {
        now: NOW,
        fees: [],
        rewards: [
          { accountId: ADA, kind: 'referral', micro: 100, at: '2026-11-15T23:59:59.999Z' },
          { accountId: ADA, kind: 'referral', micro: 100, at: '2026-11-16T00:00:00.000Z' },
          { accountId: ADA, kind: 'referral', micro: 100, at: '2026-11-16T09:00:00.000Z' },
          { accountId: BEN, kind: 'adjustment', micro: -50, at: '2026-11-16T09:00:00.000Z' },
        ],
        excluded: [],
      },
      { exclude: true }
    );
    assert.deepEqual(r.weeks.map((w) => [w.week_start, w.referral_usd, w.referrers]), [['2026-11-09', 0.0001, 1], ['2026-11-16', 0.0002, 1]]);
    assert.deepEqual(r.top.map((t) => t.accountId), [ADA]);
  });

  it('nothing yet: no weeks, no earners, no CSV', () => {
    const r = M.computeRewardsAdmin({ now: NOW, fees: [], rewards: [], excluded: [] }, { exclude: true });
    assert.deepEqual([r.weeks, r.top, M.rewardsAdminCsv(r)], [[], [], '']);
  });

  it('the CSV: one row per week, every figure a column', () => {
    const csv = M.rewardsAdminCsv(M.computeRewardsAdmin(input(), { exclude: true })).split('\n');
    assert.match(csv[0], /^week_start,partial,fees_charged,fees_usd,fees_net_usd,cashback_usd,referral_usd,business_usd,adjustment_usd,rewards_usd,reward_share,kept_usd,accounts_rewarded,referrers,businesses_rewarded$/);
    assert.match(csv[1], /^2026-11-09,false,1,0\.02,0\.015,/);
    assert.equal(csv.length, 4);
  });
});

describe('the reads', () => {
  it('charged fees, every reward and the excluded accounts; usernames only for the top earners', async () => {
    const fake = createFakeSupabase({
      fee_ledger: [
        { id: '1', account_id: ADA, state: 'charged', fee_usd_micro: '20000', net_usd_micro: null, settled_at: '2026-11-17T10:00:00.000Z' },
        { id: '2', account_id: ADA, state: 'pending', fee_usd_micro: '20000', net_usd_micro: null, settled_at: null },
      ],
      reward_entries: [{ id: '1', account_id: ADA, kind: 'cashback', usd_micro: '750', created_at: '2026-11-17T10:01:00.000Z' }],
      metrics_excluded_accounts: [{ account_id: TEAM }],
      accounts: [{ id: ADA, username: 'ada' }, { id: BEN, username: null }],
    });
    const inp = await D.loadRewardsAdminInput(fake.client, NOW);
    assert.deepEqual(inp.fees, [{ accountId: ADA, feeMicro: 20000, netMicro: null, at: '2026-11-17T10:00:00.000Z' }]);
    assert.deepEqual(inp.rewards, [{ accountId: ADA, kind: 'cashback', micro: 750, at: '2026-11-17T10:01:00.000Z' }]);
    assert.deepEqual(inp.excluded, [TEAM]);
    assert.deepEqual(await D.loadUsernames(fake.client, [ADA, BEN]), { a: 'ada' });
    assert.deepEqual(await D.loadUsernames(fake.client, []), {});
    // Only these columns are read.
    const selects = [...read('web/lib/rewardsAdminData.ts').matchAll(/\.select\('([^']*)'\)/g)].map((m) => m[1]);
    assert.deepEqual(selects, ['account_id, fee_usd_micro, net_usd_micro, settled_at', 'account_id, kind, usd_micro, created_at', 'account_id', 'id, username']);
  });

  it('a failed read throws instead of showing wrong figures', async () => {
    const fake = createFakeSupabase({ fee_ledger: [], reward_entries: [], metrics_excluded_accounts: [] });
    const from = fake.client.from.bind(fake.client);
    fake.client.from = (t) => {
      const q = from(t);
      if (t === 'reward_entries') q.range = () => Promise.resolve({ data: null, error: { message: 'down' } });
      return q;
    };
    await assert.rejects(D.loadRewardsAdminInput(fake.client, NOW), /down/);
  });
});

describe('the page and the CSV route', () => {
  it('admins only, checked on the server before anything is read; never indexed', () => {
    const page = read('web/app/dashboard/admin/rewards/page.tsx');
    assert.ok(page.indexOf('notFound()') > 0 && page.indexOf('notFound()') < page.indexOf('loadRewardsAdminInput(db)'));
    assert.match(page, /noindex: true/);
    assert.match(page, /const without = computeRewardsAdmin\(input, \{ exclude: true \}\);\s*const everyone = computeRewardsAdmin\(input, \{ exclude: false \}\);/);
    const route = read('web/app/api/admin/rewards/route.ts');
    assert.ok(route.indexOf("{ status: 404 }") > 0 && route.indexOf("{ status: 404 }") < route.indexOf('loadRewardsAdminInput(db)'));
    assert.match(route, /'X-Robots-Tag': 'noindex'/);
    assert.match(route, /searchParams\.get\('exclude'\) !== '0'/);
  });

  it('built from the traction dashboard\'s own header, cards and tables, and it never fetches', () => {
    const view = read('web/components/RewardsDashboard.tsx');
    assert.match(view, /import \{ ModeButton, SparkIcon, StatCard, Svg, TableCard, UsersIcon, WalletIcon, type Section \} from '\.\/TractionDashboard';/);
    assert.match(view, /<TableCard key=\{`\$\{mode\}-\$\{s\.id\}`\} section=\{s\} weeks=\{weeks\} \/>/);
    assert.match(view, /href=\{`\/api\/admin\/rewards\$\{mode === 'without' \? '' : '\?exclude=0'\}`\}/);
    assert.doesNotMatch(view, /fetch\(|getSupabase|loadRewardsAdminInput/);
    const traction = read('web/components/TractionDashboard.tsx');
    assert.match(traction, /if \(col\.kind === 'usd'\) return fmt\(weeks\.reduce/);
  });

  it('dollars: cents from $1, up to four decimals below it', () => {
    for (const [v, text] of [[0, '$0.00'], [1234.5, '$1,234.50'], [0.0015, '$0.0015'], [0.5, '$0.5'], [-0.0005, '-$0.0005']]) {
      assert.equal(U.usdText(v), text, String(v));
    }
    assert.match(read('web/components/TractionDashboard.tsx'), /if \(kind === 'usd'\) return usdText\(value\);/);
  });
});
