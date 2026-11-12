import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { pageMetadata } from '../../../../lib/seo';
import { isAdminAccount } from '../../../../lib/admin.ts';
import { loadTractionInput } from '../../../../lib/tractionData.ts';
import { computeTraction } from '../../../../lib/traction.ts';
import { TractionDashboard } from '../../../../components/TractionDashboard';
import { describeCallingCode } from '../../../../../lib/phoneCountries';

/**
 * Private traction dashboard for Flizy admins (accounts.is_admin, checked on
 * the server; anyone else gets a 404). Both views, without and with the test
 * and team accounts, are computed here from web/lib/traction.ts and handed to
 * the dashboard, so it switches between them without asking again. Counts and
 * aggregates only: no phone, email, name or address is read into the page.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata({
  title: 'Traction | Flizy',
  description: 'Private.',
  path: '/dashboard/admin/traction',
  noindex: true,
});

const DEFINITIONS: Array<[string, string]> = [
  ['Week', 'Monday 00:00 UTC to the next Monday. The current week is marked as running.'],
  ['Total users', 'Registered accounts: an email, not deleted.'],
  ['New users', 'Accounts registered during the week.'],
  ['Activated', 'Registered, email verified, and a WhatsApp or Telegram chat linked at some point; dated by the first link.'],
  ['Payment', 'A confirmed transfer from a Flizy account to another Flizy account, or an escrow claim it made. Not a swap, an NFT trade, a send to your own wallet, or an API payout. Sends to wallets no Flizy account holds are counted apart.'],
  ['Repeat payer', 'A payer this week who also paid in an earlier week.'],
  ['Repeat pair', 'A payer and recipient with two or more payments so far.'],
  ['Organic and incentivised', 'Tagged on each payment from the day tagging started: payments to the starter-pack host are incentivised. Older payments are untagged.'],
  ['Given an incentive', 'Received faucet money or won a task before the week ended.'],
  ['Qualified referral', 'An invited account that linked a chat and made three organic payments.'],
  ['Country', 'From the calling code of a verified phone only. Accounts with no verified phone are unknown.'],
  ['Without team', 'Leaves out every payment, account and platform the test and team accounts are on, either side.'],
];

export default async function TractionPage() {
  const db = getSupabase();
  if (!(await isAdminAccount(db, await getAccountIdFromCookie()))) notFound();
  const input = await loadTractionInput(db);
  const without = computeTraction(input, { exclude: true });
  const everyone = computeTraction(input, { exclude: false });
  const countryNames = Object.fromEntries(
    [...new Set([...without.countries, ...everyone.countries].map((c) => c.dial).filter(Boolean))].map((dial) => [dial, describeCallingCode(dial)])
  );
  return <TractionDashboard without={without} everyone={everyone} countryNames={countryNames} definitions={DEFINITIONS} />;
}
