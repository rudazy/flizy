import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { pageMetadata } from '../../../../lib/seo';
import { isAdminAccount } from '../../../../lib/admin.ts';
import { loadRewardsAdminInput, loadUsernames } from '../../../../lib/rewardsAdminData.ts';
import { computeRewardsAdmin } from '../../../../lib/rewardsAdmin.ts';
import { RewardsDashboard } from '../../../../components/RewardsDashboard';

/**
 * Private rewards dashboard for Flizy admins (accounts.is_admin, checked on
 * the server; anyone else gets a 404), laid out like the traction dashboard.
 * Both views, without and with the test and team accounts, are computed here
 * from web/lib/rewardsAdmin.ts and handed to the dashboard. Amounts and counts,
 * plus the usernames of the top earners.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata({
  title: 'Rewards | Flizy',
  description: 'Private.',
  path: '/dashboard/admin/rewards',
  noindex: true,
});

const DEFINITIONS: Array<[string, string]> = [
  ['Week', 'Monday 00:00 UTC to the next Monday. The current week is marked as running.'],
  ['Fees', 'Charged fees in the fee ledger, in the week they settled: person-to-person, business, swap and API payout fees.'],
  ['Net fees', 'Fees less the gas Flizy paid for them. Where that gas is not known, the gross fee. Rewards are shares of this.'],
  ['Rewards', 'Rewards recorded in the week: cashback, referral and business rewards, and any hand-written adjustment.'],
  ['Share of net fees', 'Rewards recorded in the week divided by the net fees of the week.'],
  ['Kept', 'Net fees of the week less the rewards recorded in it.'],
  ['Points', 'What users see. One point is one cent of reward.'],
  ['Top earners', 'Accounts with the most rewards so far.'],
  ['Without team', 'Leaves out the fees paid by, and the rewards earned by, the test and team accounts.'],
];

export default async function RewardsAdminPage() {
  const db = getSupabase();
  if (!(await isAdminAccount(db, await getAccountIdFromCookie()))) notFound();
  const input = await loadRewardsAdminInput(db);
  const without = computeRewardsAdmin(input, { exclude: true });
  const everyone = computeRewardsAdmin(input, { exclude: false });
  const usernames = await loadUsernames(db, [...new Set([...without.top, ...everyone.top].map((r) => r.accountId))]);
  return <RewardsDashboard without={without} everyone={everyone} usernames={usernames} definitions={DEFINITIONS} />;
}
