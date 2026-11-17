'use client';

import { useState } from 'react';
import type { RewardsAdminResult, RewardsWeek } from '../lib/rewardsAdmin.ts';
import { usdText } from '../lib/usdText.ts';
import { ModeButton, SparkIcon, StatCard, Svg, TableCard, UsersIcon, WalletIcon, type Section } from './TractionDashboard';

/**
 * The private rewards dashboard (web/app/dashboard/admin/rewards), built from
 * the traction dashboard's cards and tables so the two read the same way. Both
 * views, without and with the test and team accounts, are computed on the
 * server and handed in. Amounts, counts and weeks, plus the usernames of the
 * top earners.
 */

type Mode = 'without' | 'everyone';

const GOLD = '#f7d047';

const SECTIONS: Section<RewardsWeek>[] = [
  {
    id: 'fees',
    title: 'Fees',
    icon: <WalletIcon />,
    cols: [
      { key: 'fees_charged', label: 'Charged', hint: 'Fees charged in the week.', kind: 'count' },
      { key: 'fees_usd', label: 'Gross', hint: 'What those fees came to.', kind: 'usd' },
      { key: 'fees_net_usd', label: 'Net', hint: 'Less the gas Flizy paid for them; the gross fee where that gas is not known.', kind: 'usd' },
    ],
  },
  {
    id: 'rewards',
    title: 'Rewards',
    icon: <SparkIcon />,
    cols: [
      { key: 'cashback_usd', label: 'Cashback', hint: 'Cashback recorded in the week.', kind: 'usd' },
      { key: 'referral_usd', label: 'Referral', hint: 'Referral rewards recorded in the week.', kind: 'usd' },
      { key: 'business_usd', label: 'Business', hint: 'Business rewards recorded in the week.', kind: 'usd' },
      { key: 'adjustment_usd', label: 'Adjustments', hint: 'Corrections written by hand.', kind: 'usd' },
      { key: 'rewards_usd', label: 'Total', hint: 'Every reward recorded in the week.', kind: 'usd' },
      { key: 'reward_share', label: 'Share of net fees', hint: 'Rewards divided by the net fees of the week.', kind: 'rate' },
      { key: 'kept_usd', label: 'Kept', hint: 'Net fees less rewards.', kind: 'usd' },
    ],
  },
  {
    id: 'earners',
    title: 'Earners',
    icon: <UsersIcon />,
    cols: [
      { key: 'accounts_rewarded', label: 'Accounts rewarded', hint: 'Accounts that earned a reward in the week.', kind: 'count' },
      { key: 'referrers', label: 'Referrers', hint: 'Accounts that earned a referral reward in the week.', kind: 'count' },
      { key: 'businesses_rewarded', label: 'Businesses', hint: 'Businesses that earned a business reward in the week.', kind: 'count' },
    ],
  },
];

export function RewardsDashboard({
  without,
  everyone,
  usernames,
  definitions,
}: {
  without: RewardsAdminResult;
  everyone: RewardsAdminResult;
  usernames: Record<string, string>;
  definitions: Array<[string, string]>;
}) {
  const [mode, setMode] = useState<Mode>('without');
  const result = mode === 'without' ? without : everyone;
  const weeks = result.weeks;
  const latest = weeks[weeks.length - 1];
  const before = weeks[weeks.length - 2];
  const recent = weeks.slice(-12);
  const change = (key: 'rewards_usd' | 'fees_net_usd') => {
    if (!latest || !before) return null;
    const d = latest[key] - before[key];
    return { text: usdText(Math.abs(d)), up: d >= 0, zero: d === 0 };
  };
  const weekNote = latest?.partial ? 'This week so far, against last week' : 'This week, against last week';

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5 px-4 pb-10 pt-6">
      <header className="relative overflow-hidden rounded-[18px] px-1 pb-2 pt-3">
        <svg className="pointer-events-none absolute -right-10 -top-6 h-[180px] w-[70%]" viewBox="0 0 400 180" fill="none" aria-hidden>
          <path d="M0 170 C 140 170, 220 120, 400 6" stroke={GOLD} strokeOpacity="0.55" strokeWidth="1.4" />
          <path d="M0 176 C 150 176, 240 132, 400 22" stroke={GOLD} strokeOpacity="0.18" strokeWidth="8" />
        </svg>
        <h1 className="relative m-0 font-sans text-[34px] font-bold tracking-wide text-[#f5f5f5]">Rewards</h1>
        <p className="relative m-0 mt-1 font-sans text-[14px] text-[#a8a29a]">
          Weekly fees and rewards, {mode === 'without' ? 'without' : 'with'} test and team accounts. {usdText(result.totals.rewards_usd)} of rewards on{' '}
          {usdText(result.totals.fees_net_usd)} of net fees so far.
        </p>
        <div className="relative mt-5 grid grid-cols-3 gap-2.5">
          <ModeButton active={mode === 'without'} onClick={() => setMode('without')}>
            Without team
          </ModeButton>
          <ModeButton active={mode === 'everyone'} onClick={() => setMode('everyone')}>
            Everyone
          </ModeButton>
          <a
            href={`/api/admin/rewards${mode === 'without' ? '' : '?exclude=0'}`}
            className="flex min-h-[48px] items-center justify-center whitespace-nowrap rounded-[14px] border border-[#2c2820] bg-[#0f0e0c] px-1.5 text-center font-sans text-[12.5px] font-semibold text-[#f2ebe1] no-underline hover:border-[#4a3f22] sm:text-[13px]"
          >
            Download CSV
          </a>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<SparkIcon />}
          label="Rewards"
          value={usdText(latest ? latest.rewards_usd : 0)}
          change={change('rewards_usd')}
          note={weekNote}
          series={recent.map((w) => w.rewards_usd)}
        />
        <StatCard
          icon={<WalletIcon />}
          label="Net fees"
          value={usdText(latest ? latest.fees_net_usd : 0)}
          change={change('fees_net_usd')}
          note={weekNote}
          series={recent.map((w) => w.fees_net_usd)}
        />
      </section>

      {SECTIONS.map((s) => (
        <TableCard key={`${mode}-${s.id}`} section={s} weeks={weeks} />
      ))}

      <TopEarnersCard top={result.top} usernames={usernames} />

      <details className="group rounded-[18px] border border-[#2a2620] bg-[linear-gradient(165deg,#15130f,#0f0e0c)] px-5 py-4">
        <summary className="flex cursor-pointer list-none items-center justify-between font-sans text-[16px] font-semibold text-[#f5f5f5]">
          Definitions
          <span className="font-sans text-[12px] font-medium text-[#a8a29a] group-open:hidden">Show</span>
          <span className="hidden font-sans text-[12px] font-medium text-[#a8a29a] group-open:inline">Hide</span>
        </summary>
        <dl className="m-0 mt-3 grid gap-3 sm:grid-cols-2">
          {definitions.map(([term, meaning]) => (
            <div key={term}>
              <dt className="font-sans text-[13px] font-semibold text-[#f2ebe1]">{term}</dt>
              <dd className="m-0 mt-0.5 font-sans text-[12.5px] leading-relaxed text-[#a8a29a]">{meaning}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

/** The accounts with the most rewards so far, laid out like the traction page's countries. */
function TopEarnersCard({ top, usernames }: { top: RewardsAdminResult['top']; usernames: Record<string, string> }) {
  const most = top[0]?.total || 1;
  return (
    <section className="rounded-[18px] border border-[#2a2620] bg-[linear-gradient(165deg,#15130f,#0f0e0c)] px-5 py-4">
      <h2 className="m-0 flex items-center gap-3 font-sans text-[18px] font-semibold text-[#f5f5f5]">
        <span className="text-[#f7d047]">
          <TrophyIcon />
        </span>
        Top earners
      </h2>
      <p className="m-0 mt-1 font-sans text-[12px] text-[#8f877c]">Most rewards so far, with what they were for.</p>
      {top.length ? (
        <ul className="m-0 mt-3 grid list-none gap-2.5 p-0 sm:grid-cols-2 sm:gap-x-8">
          {top.map((r) => (
            <li key={r.accountId}>
              <div className="flex items-baseline justify-between gap-3 font-sans text-[13px]">
                <span className="truncate text-[#f2ebe1]">{usernames[r.accountId] ? `@${usernames[r.accountId]}` : 'No username'}</span>
                <span className="shrink-0 font-semibold text-[#f5f5f5]">{usdText(r.total)}</span>
              </div>
              <span className="mt-1 block h-[4px] overflow-hidden rounded-full bg-[#221f19]" aria-hidden>
                <span className="block h-full rounded-full bg-[#f7d047]" style={{ width: `${(r.total / most) * 100}%` }} />
              </span>
              <p className="m-0 mt-1 font-sans text-[11px] text-[#8f877c]">
                Cashback {usdText(r.cashback)}, referral {usdText(r.referral)}, business {usdText(r.business)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mt-3 font-sans text-[13px] text-[#a8a29a]">No rewards recorded yet.</p>
      )}
    </section>
  );
}

function TrophyIcon() {
  return (
    <Svg>
      <path d="M7.5 4h9v5a4.5 4.5 0 0 1-9 0V4Z" />
      <path d="M7.5 6H4.5a3 3 0 0 0 3 4M16.5 6h3a3 3 0 0 1-3 4M12 13.5V17M8.5 20.5h7M9.5 17h5v3.5h-5z" />
    </Svg>
  );
}
