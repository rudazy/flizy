import { weekStart } from './traction.ts';

/**
 * The private rewards figures (web/app/dashboard/admin/rewards): fees charged
 * and rewards recorded, by week, and the accounts that earned the most. Pure:
 * the rows come from web/lib/rewardsAdminData.ts.
 *
 * Amounts are worked out in micro-USD and handed on in dollars. A fee counts
 * in the week it settled, a reward in the week it was recorded. "Without team"
 * leaves out the fees paid by, and the rewards earned by, the accounts in
 * metrics_excluded_accounts.
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;
const TOP = 10;

export type RewardsAdminInput = {
  now: number;
  fees: Array<{ accountId: string | null; feeMicro: number; netMicro: number | null; at: string | null }>;
  rewards: Array<{ accountId: string; kind: 'cashback' | 'referral' | 'merchant' | 'adjustment'; micro: number; at: string }>;
  excluded: string[];
};

export type RewardsWeek = {
  week_start: string;
  partial: boolean;
  fees_charged: number;
  fees_usd: number;
  fees_net_usd: number;
  cashback_usd: number;
  referral_usd: number;
  business_usd: number;
  adjustment_usd: number;
  rewards_usd: number;
  reward_share: number | null;
  kept_usd: number;
  accounts_rewarded: number;
  referrers: number;
  businesses_rewarded: number;
};

export type RewardsEarner = { accountId: string; total: number; cashback: number; referral: number; business: number };

export type RewardsAdminResult = {
  excluded: boolean;
  weeks: RewardsWeek[];
  totals: { fees_net_usd: number; rewards_usd: number };
  top: RewardsEarner[];
};

const usd = (micro: number) => micro / 1_000_000;

function ms(iso: string | null): number {
  const v = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : NaN;
}

/** What a fee's rewards are shares of: net of gas where known, else the gross fee. */
const netOf = (f: RewardsAdminInput['fees'][number]) => (f.netMicro == null ? f.feeMicro : f.netMicro);

export function computeRewardsAdmin(input: RewardsAdminInput, opts: { exclude: boolean }): RewardsAdminResult {
  const excluded = new Set(opts.exclude ? input.excluded : []);
  const fees = input.fees.filter((f) => Number.isFinite(ms(f.at)) && !(f.accountId && excluded.has(f.accountId)));
  const rewards = input.rewards.filter((r) => Number.isFinite(ms(r.at)) && !excluded.has(r.accountId));

  const times = [...fees.map((f) => ms(f.at)), ...rewards.map((r) => ms(r.at))];
  const weeks: RewardsWeek[] = [];
  if (times.length) {
    for (let s = weekStart(Math.min(...times)); s <= input.now; s += WEEK_MS) {
      const e = s + WEEK_MS;
      const inWeek = (t: number) => t >= s && t < e;
      const wf = fees.filter((f) => inWeek(ms(f.at)));
      const wr = rewards.filter((r) => inWeek(ms(r.at)));
      const sum = (rows: Array<{ micro: number }>) => rows.reduce((n, r) => n + r.micro, 0);
      const ofKind = (k: string) => wr.filter((r) => r.kind === k);
      const feesNet = wf.reduce((n, f) => n + netOf(f), 0);
      const total = sum(wr);
      weeks.push({
        week_start: new Date(s).toISOString().slice(0, 10),
        partial: e > input.now,
        fees_charged: wf.length,
        fees_usd: usd(wf.reduce((n, f) => n + f.feeMicro, 0)),
        fees_net_usd: usd(feesNet),
        cashback_usd: usd(sum(ofKind('cashback'))),
        referral_usd: usd(sum(ofKind('referral'))),
        business_usd: usd(sum(ofKind('merchant'))),
        adjustment_usd: usd(sum(ofKind('adjustment'))),
        rewards_usd: usd(total),
        reward_share: feesNet > 0 ? Math.round((total / feesNet) * 10000) / 10000 : null,
        kept_usd: usd(feesNet - total),
        accounts_rewarded: new Set(wr.map((r) => r.accountId)).size,
        referrers: new Set(ofKind('referral').map((r) => r.accountId)).size,
        businesses_rewarded: new Set(ofKind('merchant').map((r) => r.accountId)).size,
      });
    }
  }

  const byAccount = new Map<string, RewardsEarner>();
  for (const r of rewards) {
    const row = byAccount.get(r.accountId) || { accountId: r.accountId, total: 0, cashback: 0, referral: 0, business: 0 };
    row.total += r.micro;
    if (r.kind === 'cashback') row.cashback += r.micro;
    else if (r.kind === 'referral') row.referral += r.micro;
    else if (r.kind === 'merchant') row.business += r.micro;
    byAccount.set(r.accountId, row);
  }
  const top = [...byAccount.values()]
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.accountId.localeCompare(b.accountId))
    .slice(0, TOP)
    .map((r) => ({ ...r, total: usd(r.total), cashback: usd(r.cashback), referral: usd(r.referral), business: usd(r.business) }));

  return {
    excluded: opts.exclude,
    weeks,
    totals: { fees_net_usd: usd(fees.reduce((n, f) => n + netOf(f), 0)), rewards_usd: usd(rewards.reduce((n, r) => n + r.micro, 0)) },
    top,
  };
}

/** The weeks as CSV, one row per week, every figure a column. */
export function rewardsAdminCsv(result: RewardsAdminResult): string {
  if (!result.weeks.length) return '';
  const cols = Object.keys(result.weeks[0]) as Array<keyof RewardsWeek>;
  const cell = (v: unknown) => (v == null ? '' : String(v));
  return [cols.join(','), ...result.weeks.map((w) => cols.map((c) => cell(w[c])).join(','))].join('\n') + '\n';
}
