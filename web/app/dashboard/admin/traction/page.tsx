import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { pageMetadata } from '../../../../lib/seo';
import { isAdminAccount } from '../../../../lib/admin.ts';
import { loadTractionInput } from '../../../../lib/tractionData.ts';
import { computeTraction, type WeekMetrics } from '../../../../lib/traction.ts';
import { describeCallingCode } from '../../../../../lib/phoneCountries';

/**
 * Private traction dashboard for Flizy admins (accounts.is_admin, checked on
 * the server; anyone else gets a 404). Weekly figures from web/lib/traction.ts,
 * with or without the test and team accounts. Counts and aggregates only:
 * no phone, email, name or address is read into the page.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata({
  title: 'Traction | Flizy',
  description: 'Private.',
  path: '/dashboard/admin/traction',
  noindex: true,
});

type Props = { searchParams: Promise<{ exclude?: string }> };

const pct = (v: number | null) => (v == null ? '-' : `${Math.round(v * 1000) / 10}%`);
const num = (v: number | null) => (v == null ? '-' : String(v));

const GROUPS: Array<{ title: string; cols: Array<{ key: keyof WeekMetrics; label: string; rate?: boolean }> }> = [
  {
    title: 'Users',
    cols: [
      { key: 'registered_total', label: 'Registered' },
      { key: 'registered_new', label: 'New' },
      { key: 'activated_total', label: 'Activated' },
      { key: 'activated_new', label: 'Newly activated' },
    ],
  },
  {
    title: 'Payments',
    cols: [
      { key: 'first_time_payers', label: 'First-time payers' },
      { key: 'active_payers', label: 'Active payers' },
      { key: 'repeat_payer_rate', label: 'Repeat payer rate', rate: true },
      { key: 'payments', label: 'Payments' },
      { key: 'payments_per_active_payer', label: 'Per payer' },
      { key: 'repeat_pairs_total', label: 'Repeat pairs' },
      { key: 'external_payments', label: 'To outside wallets' },
    ],
  },
  {
    title: 'Claims',
    cols: [
      { key: 'claims_created', label: 'Created' },
      { key: 'claims_claimed', label: 'Claimed' },
      { key: 'claims_cancelled', label: 'Cancelled' },
      { key: 'claims_pending', label: 'Pending' },
      { key: 'claims_expired', label: 'Expired' },
      { key: 'claim_rate', label: 'Claim rate', rate: true },
    ],
  },
  {
    title: 'Organic and incentivised',
    cols: [
      { key: 'payments_organic', label: 'Organic' },
      { key: 'payments_incentivised', label: 'Incentivised' },
      { key: 'payments_untagged', label: 'Untagged' },
      { key: 'payers_incentivised', label: 'Payers given an incentive' },
      { key: 'payers_incentivised_repeat_rate', label: 'Their repeat rate', rate: true },
      { key: 'payers_not_incentivised', label: 'Other payers' },
      { key: 'payers_not_incentivised_repeat_rate', label: 'Their repeat rate', rate: true },
      { key: 'referrals_qualified_new', label: 'Qualified referrals' },
    ],
  },
  {
    title: 'Flizy Pay API',
    cols: [
      { key: 'api_requests', label: 'Requests' },
      { key: 'api_request_errors', label: 'Errors' },
      { key: 'api_platforms_active', label: 'Platforms' },
      { key: 'api_payouts_created', label: 'Payouts' },
      { key: 'api_payout_success_rate', label: 'Payout success', rate: true },
      { key: 'api_payments_created', label: 'Checkouts' },
      { key: 'api_payment_success_rate', label: 'Checkout success', rate: true },
    ],
  },
];

const DEFINITIONS: Array<[string, string]> = [
  ['Week', 'Monday 00:00 UTC to the next Monday. The current week is marked as running.'],
  ['Registered', 'An account with an email that is not deleted.'],
  ['Activated', 'Registered, email verified, and a WhatsApp or Telegram chat linked at some point; dated by the first link.'],
  ['Payment', 'A confirmed transfer from a Flizy account to another Flizy account, or an escrow claim it made. Not a swap, an NFT trade, a send to your own wallet, or an API payout. Sends to wallets no Flizy account holds are counted apart.'],
  ['Repeat payer', 'A payer this week who also paid in an earlier week.'],
  ['Repeat pair', 'A payer and recipient with two or more payments so far.'],
  ['Organic and incentivised', 'Tagged on each payment from the day tagging started: payments to the starter-pack host are incentivised. Older payments are untagged.'],
  ['Given an incentive', 'Received faucet money or won a task before the week ended.'],
  ['Qualified referral', 'An invited account that linked a chat and made three organic payments.'],
  ['Country', 'From the calling code of a verified phone only. Accounts with no verified phone are unknown.'],
];

export default async function TractionPage(props: Props) {
  const db = getSupabase();
  if (!(await isAdminAccount(db, await getAccountIdFromCookie()))) notFound();
  const exclude = (await props.searchParams)?.exclude !== '0';
  const result = computeTraction(await loadTractionInput(db), { exclude });
  const weeks = [...result.weeks].reverse();

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5 px-4 py-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-sans text-2xl tracking-wide text-paper">Traction</h1>
          <p className="m-0 mt-1 text-sm text-muted">
            Weekly, {exclude ? 'without' : 'with'} test and team accounts. Definition version {result.definitionVersion}.
          </p>
        </div>
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link href="/dashboard/admin/traction" className={`btn min-h-[44px] no-underline ${exclude ? 'btn-primary' : 'btn-ghost'}`}>
            Without team
          </Link>
          <Link href="/dashboard/admin/traction?exclude=0" className={`btn min-h-[44px] no-underline ${exclude ? 'btn-ghost' : 'btn-primary'}`}>
            Everyone
          </Link>
          <a href={`/api/admin/traction${exclude ? '' : '?exclude=0'}`} className="btn btn-ghost min-h-[44px] no-underline">
            Download CSV
          </a>
        </nav>
      </header>

      {GROUPS.map((group) => (
        <section key={group.title} className="card p-4">
          <h2 className="m-0 mb-3 font-sans text-base tracking-wide text-paper">{group.title}</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left font-mono text-xs">
              <thead>
                <tr className="text-muted">
                  <th className="py-1.5 pr-3 font-normal">Week</th>
                  {group.cols.map((c) => (
                    <th key={c.key} className="py-1.5 pr-3 font-normal">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((w) => (
                  <tr key={w.week_start} className="border-t border-border">
                    <td className="py-1.5 pr-3 text-paper">
                      {w.week_start}
                      {w.partial ? <span className="text-muted"> (running)</span> : null}
                    </td>
                    {group.cols.map((c) => (
                      <td key={c.key} className="py-1.5 pr-3 text-paper">
                        {c.rate ? pct(w[c.key] as number | null) : num(w[c.key] as number | null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="card p-4">
        <h2 className="m-0 mb-3 font-sans text-base tracking-wide text-paper">Registered accounts by country</h2>
        <ul className="m-0 grid list-none gap-1 p-0 font-mono text-xs sm:grid-cols-2">
          {result.countries.map((c) => (
            <li key={c.dial || 'unknown'} className="flex justify-between gap-3 border-t border-border py-1.5">
              <span className="text-paper">{c.dial ? describeCallingCode(c.dial) : 'Unknown (no verified phone)'}</span>
              <span className="text-paper">{c.accounts}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card p-4">
        <h2 className="m-0 mb-3 font-sans text-base tracking-wide text-paper">Definitions</h2>
        <dl className="m-0 grid gap-2 text-sm">
          {DEFINITIONS.map(([term, meaning]) => (
            <div key={term}>
              <dt className="text-paper">{term}</dt>
              <dd className="m-0 text-muted">{meaning}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
