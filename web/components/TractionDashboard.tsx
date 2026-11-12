'use client';

import { useId, useMemo, useState, type ReactNode } from 'react';
import type { TractionResult, WeekMetrics } from '../lib/traction.ts';

/**
 * The private traction dashboard (web/app/dashboard/admin/traction). Both
 * views, without and with the test and team accounts, are computed on the
 * server and handed in, so the switch is instant. Everything here is a count,
 * a rate or a week: nothing identifies anyone.
 *
 * Each table pages five weeks at a time (View all shows every week), sorts by
 * any column, keeps the week column in place while it scrolls sideways, marks
 * the change from the week before under each count, and closes with a summary
 * row: the latest figure for running totals, the sum for weekly counts.
 */

type Mode = 'without' | 'everyone';
type Kind = 'count' | 'total' | 'rate' | 'ratio';
type Col = { key: keyof WeekMetrics; label: string; hint: string; kind: Kind };
type Section = { id: string; title: string; icon: ReactNode; cols: Col[] };

const GOLD = '#f7d047';
const PAGE = 5;

const SECTIONS: Section[] = [
  {
    id: 'users',
    title: 'Users',
    icon: <UsersIcon />,
    cols: [
      { key: 'registered_total', label: 'Registered', hint: 'Accounts with an email that are not deleted, by the end of the week.', kind: 'total' },
      { key: 'registered_new', label: 'New', hint: 'Accounts registered during the week.', kind: 'count' },
      { key: 'activated_total', label: 'Activated', hint: 'Registered, email verified and a WhatsApp or Telegram chat linked.', kind: 'total' },
      { key: 'activated_new', label: 'Newly activated', hint: 'Accounts that became activated during the week.', kind: 'count' },
    ],
  },
  {
    id: 'payments',
    title: 'Payments',
    icon: <WalletIcon />,
    cols: [
      { key: 'first_time_payers', label: 'First-time payers', hint: 'Accounts that made their first payment this week.', kind: 'count' },
      { key: 'active_payers', label: 'Active payers', hint: 'Accounts that paid another person this week.', kind: 'count' },
      { key: 'repeat_payer_rate', label: 'Repeat payer rate', hint: 'Share of this week\'s payers who also paid in an earlier week.', kind: 'rate' },
      { key: 'payments', label: 'Payments', hint: 'Person-to-person payments: transfers to another Flizy account, and escrow claims.', kind: 'count' },
      { key: 'payments_per_active_payer', label: 'Per payer', hint: 'Payments divided by active payers.', kind: 'ratio' },
      { key: 'repeat_pairs_total', label: 'Repeat pairs', hint: 'Payer and recipient pairs with two or more payments so far.', kind: 'total' },
      { key: 'external_payments', label: 'To outside wallets', hint: 'Sends to wallets no Flizy account holds. Not counted as payments.', kind: 'count' },
    ],
  },
  {
    id: 'claims',
    title: 'Claims',
    icon: <ShieldIcon />,
    cols: [
      { key: 'claims_created', label: 'Created', hint: 'Escrow claims created this week.', kind: 'count' },
      { key: 'claims_claimed', label: 'Claimed', hint: 'Of those, claimed by the recipient.', kind: 'count' },
      { key: 'claims_cancelled', label: 'Cancelled', hint: 'Of those, cancelled by the sender.', kind: 'count' },
      { key: 'claims_pending', label: 'Pending', hint: 'Of those, still waiting to be claimed.', kind: 'count' },
      { key: 'claims_expired', label: 'Expired', hint: 'Of those, past their expiry.', kind: 'count' },
      { key: 'claim_rate', label: 'Claim rate', hint: 'Claimed divided by created.', kind: 'rate' },
    ],
  },
  {
    id: 'incentives',
    title: 'Organic and incentivised',
    icon: <SparkIcon />,
    cols: [
      { key: 'payments_organic', label: 'Organic', hint: 'Payments tagged organic.', kind: 'count' },
      { key: 'payments_incentivised', label: 'Incentivised', hint: 'Payments to the starter-pack host or a system wallet.', kind: 'count' },
      { key: 'payments_untagged', label: 'Untagged', hint: 'Payments from before tagging started.', kind: 'count' },
      { key: 'payers_incentivised', label: 'Given an incentive', hint: 'Payers who had received faucet money or won a task.', kind: 'count' },
      { key: 'payers_incentivised_repeat_rate', label: 'Their repeat rate', hint: 'Repeat payer rate of payers given an incentive.', kind: 'rate' },
      { key: 'payers_not_incentivised', label: 'Other payers', hint: 'Payers never given an incentive.', kind: 'count' },
      { key: 'payers_not_incentivised_repeat_rate', label: 'Their repeat rate', hint: 'Repeat payer rate of the other payers.', kind: 'rate' },
      { key: 'referrals_qualified_new', label: 'Qualified referrals', hint: 'Invited accounts that linked a chat and made three organic payments.', kind: 'count' },
    ],
  },
  {
    id: 'api',
    title: 'Flizy Pay API',
    icon: <CodeIcon />,
    cols: [
      { key: 'api_requests', label: 'Requests', hint: 'Authenticated API calls.', kind: 'count' },
      { key: 'api_request_errors', label: 'Errors', hint: 'Calls answered 400 or above.', kind: 'count' },
      { key: 'api_platforms_active', label: 'Platforms', hint: 'Platforms that called the API.', kind: 'count' },
      { key: 'api_payouts_created', label: 'Payouts', hint: 'Payouts created.', kind: 'count' },
      { key: 'api_payout_success_rate', label: 'Payout success', hint: 'Confirmed divided by confirmed plus failed.', kind: 'rate' },
      { key: 'api_payments_created', label: 'Checkouts', hint: 'Checkouts created.', kind: 'count' },
      { key: 'api_payment_success_rate', label: 'Checkout success', hint: 'Confirmed divided by confirmed plus expired.', kind: 'rate' },
    ],
  },
];

export function TractionDashboard({
  without,
  everyone,
  countryNames,
  definitions,
}: {
  without: TractionResult;
  everyone: TractionResult;
  countryNames: Record<string, string>;
  definitions: Array<[string, string]>;
}) {
  const [mode, setMode] = useState<Mode>('without');
  const result = mode === 'without' ? without : everyone;
  const weeks = result.weeks;
  const latest = weeks[weeks.length - 1];
  const before = weeks[weeks.length - 2];
  const totalChange = latest && before && before.registered_total > 0 ? (latest.registered_total - before.registered_total) / before.registered_total : null;
  const newChange = latest && before ? latest.registered_new - before.registered_new : null;
  const recent = weeks.slice(-12);

  return (
    <div className="mx-auto w-full max-w-[1200px] space-y-5 px-4 pb-10 pt-6">
      <header className="relative overflow-hidden rounded-[18px] px-1 pb-2 pt-3">
        <svg className="pointer-events-none absolute -right-10 -top-6 h-[180px] w-[70%]" viewBox="0 0 400 180" fill="none" aria-hidden>
          <path d="M0 170 C 140 170, 220 120, 400 6" stroke={GOLD} strokeOpacity="0.55" strokeWidth="1.4" />
          <path d="M0 176 C 150 176, 240 132, 400 22" stroke={GOLD} strokeOpacity="0.18" strokeWidth="8" />
        </svg>
        <h1 className="relative m-0 font-sans text-[34px] font-bold tracking-wide text-[#f5f5f5]">Traction</h1>
        <p className="relative m-0 mt-1 font-sans text-[14px] text-[#a8a29a]">
          Weekly activity, {mode === 'without' ? 'without' : 'with'} test and team accounts. Definition version {result.definitionVersion}.
        </p>
        <div className="relative mt-5 grid grid-cols-3 gap-2.5">
          <ModeButton active={mode === 'without'} onClick={() => setMode('without')}>
            Without team
          </ModeButton>
          <ModeButton active={mode === 'everyone'} onClick={() => setMode('everyone')}>
            Everyone
          </ModeButton>
          <a
            href={`/api/admin/traction${mode === 'without' ? '' : '?exclude=0'}`}
            className="flex min-h-[48px] items-center justify-center whitespace-nowrap rounded-[14px] border border-[#2c2820] bg-[#0f0e0c] px-1.5 text-center font-sans text-[12.5px] font-semibold text-[#f2ebe1] no-underline hover:border-[#4a3f22] sm:text-[13px]"
          >
            Download CSV
          </a>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<UsersIcon />}
          label="Total users"
          value={latest ? latest.registered_total : 0}
          change={totalChange == null ? null : { text: `${Math.abs(Math.round(totalChange * 1000) / 10)}%`, up: totalChange >= 0, zero: totalChange === 0 }}
          note="Registered, since last week"
          series={recent.map((w) => w.registered_total)}
        />
        <StatCard
          icon={<BoltIcon />}
          label="New users"
          value={latest ? latest.registered_new : 0}
          change={newChange == null ? null : { text: String(Math.abs(newChange)), up: newChange >= 0, zero: newChange === 0 }}
          note={latest?.partial ? 'This week so far, against last week' : 'This week, against last week'}
          series={recent.map((w) => w.registered_new)}
        />
      </section>

      {SECTIONS.map((s) => (
        <TableCard key={`${mode}-${s.id}`} section={s} weeks={weeks} />
      ))}

      <CountriesCard countries={result.countries} names={countryNames} />

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

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-[48px] whitespace-nowrap rounded-[14px] px-1.5 font-sans text-[12.5px] font-semibold sm:text-[13px] ${
        active
          ? 'bg-[#f7d047] text-[#1a1405] shadow-[0_8px_28px_rgba(247,208,71,0.28)]'
          : 'border border-[#2c2820] bg-[#0f0e0c] text-[#f2ebe1] hover:border-[#4a3f22]'
      }`}
    >
      {children}
    </button>
  );
}

function StatCard({
  icon,
  label,
  value,
  change,
  note,
  series,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  change: { text: string; up: boolean; zero: boolean } | null;
  note: string;
  series: number[];
}) {
  return (
    <div className="relative overflow-hidden rounded-[18px] border border-[#3a3020] bg-[linear-gradient(165deg,#17140f,#100e0b)] px-4 pb-8 pt-4 shadow-[inset_0_1px_0_rgba(247,208,71,0.08)] sm:px-5 sm:pb-6 sm:pt-5">
      <div className="relative z-10 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#1d1a12] text-[#f7d047] sm:h-12 sm:w-12">{icon}</span>
        <div className="min-w-0">
          <p className="m-0 font-sans text-[13px] text-[#cfc8bd] sm:text-[14px]">{label}</p>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="font-sans text-[30px] font-bold leading-none text-[#f5f5f5] sm:text-[34px]">{value.toLocaleString('en-US')}</span>
            {change && !change.zero ? (
              <span className={`inline-flex items-center gap-1 font-sans text-[13px] font-semibold ${change.up ? 'text-[#5fd38d]' : 'text-[#e0806a]'}`}>
                <ArrowIcon up={change.up} />
                {change.text}
              </span>
            ) : null}
          </div>
          <p className="m-0 mt-1.5 font-sans text-[11px] leading-snug text-[#8f877c] sm:text-[11.5px]">{note}</p>
        </div>
      </div>
      <Sparkline values={series} className="pointer-events-none absolute bottom-0 right-0 h-[30px] w-[70%] opacity-90 sm:h-[46px] sm:w-[46%]" />
    </div>
  );
}

function Sparkline({ values, className }: { values: number[]; className?: string }) {
  // One gradient id per chart: two cards on the page must not share one.
  const gradient = `spark-${useId().replace(/:/g, '')}`;
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 200, 46 - ((v - min) / span) * 38]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <svg className={className} viewBox="0 0 200 54" preserveAspectRatio="none" fill="none" aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={GOLD} stopOpacity="0.28" />
          <stop offset="1" stopColor={GOLD} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L200 54 L0 54 Z`} fill={`url(#${gradient})`} />
      <path d={line} stroke={GOLD} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

type Sort = { key: keyof WeekMetrics; dir: 'asc' | 'desc' };

function TableCard({ section, weeks }: { section: Section; weeks: WeekMetrics[] }) {
  const [sort, setSort] = useState<Sort>({ key: 'week_start', dir: 'desc' });
  const [page, setPage] = useState(0);
  const [all, setAll] = useState(false);

  // The week before each week, for the change shown under a count.
  const previous = useMemo(() => {
    const m = new Map<string, WeekMetrics>();
    weeks.forEach((w, i) => {
      if (i > 0) m.set(w.week_start, weeks[i - 1]);
    });
    return m;
  }, [weeks]);

  const sorted = useMemo(() => {
    const rows = [...weeks];
    rows.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const cmp =
        typeof av === 'string' && typeof bv === 'string'
          ? av.localeCompare(bv)
          : (av == null ? -Infinity : Number(av)) - (bv == null ? -Infinity : Number(bv));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [weeks, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = all ? sorted : sorted.slice(current * PAGE, current * PAGE + PAGE);
  const newest = weeks[weeks.length - 1];

  function toggleSort(key: keyof WeekMetrics) {
    setPage(0);
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  }

  function summary(col: Col): string {
    if (col.kind === 'total') return newest ? fmt(newest[col.key] as number, col.kind) : '-';
    if (col.kind === 'count') return String(weeks.reduce((n, w) => n + ((w[col.key] as number) || 0), 0));
    return '-';
  }

  return (
    <section className="rounded-[18px] border border-[#2a2620] bg-[linear-gradient(165deg,#15130f,#0f0e0c)] pb-3 pt-4 shadow-[0_12px_40px_rgba(0,0,0,0.28)]">
      <div className="flex items-center justify-between gap-3 px-5">
        <h2 className="m-0 flex items-center gap-3 font-sans text-[18px] font-semibold text-[#f5f5f5]">
          <span className="text-[#f7d047]">{section.icon}</span>
          {section.title}
        </h2>
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="min-h-[40px] rounded-full border border-[#3a352b] px-4 font-sans text-[13px] font-medium text-[#f2ebe1] hover:border-[#5a4d2a]"
        >
          {all ? 'Show fewer' : 'View all'}
        </button>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className={`w-full border-collapse text-left ${section.cols.length > 5 ? 'min-w-[560px] sm:min-w-0' : ''}`}>
          <thead>
            <tr>
              <Th sticky active={sort.key === 'week_start'} dir={sort.dir} onClick={() => toggleSort('week_start')} hint="Monday 00:00 UTC to the next Monday.">
                Week
              </Th>
              {section.cols.map((c) => (
                <Th key={c.key} active={sort.key === c.key} dir={sort.dir} onClick={() => toggleSort(c.key)} hint={c.hint}>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => {
              const prev = previous.get(w.week_start);
              return (
                <tr key={w.week_start} className="border-t border-[#221f19] hover:bg-[#17150f]">
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-[#12100d] py-3 pl-4 pr-2 align-top font-sans text-[13px] text-[#f2ebe1] sm:pl-5 sm:pr-3 sm:text-[13.5px]">
                    {w.week_start}
                    {w.partial ? <span className="mt-0.5 block font-sans text-[10.5px] font-medium text-[#f7d047]">running</span> : null}
                  </td>
                  {section.cols.map((c) => (
                    <Cell key={c.key} col={c} value={w[c.key] as number | null} prev={prev ? (prev[c.key] as number | null) : null} />
                  ))}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-[#3a3020]">
              <td className="sticky left-0 z-10 bg-[#12100d] py-3 pl-4 pr-2 font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-[#a8a29a] sm:pl-5 sm:pr-3 sm:text-[12px]">
                All weeks
              </td>
              {section.cols.map((c) => (
                <td key={c.key} className="px-2 py-3 font-sans text-[13px] font-semibold text-[#f7d047] sm:px-3 sm:text-[13.5px]">
                  {summary(c)}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>

      {!all && pages > 1 ? (
        <nav className="mt-2 flex items-center justify-center gap-2" aria-label={`${section.title} pages`}>
          <PageButton label="Previous page" disabled={current === 0} onClick={() => setPage(current - 1)}>
            <ChevronIcon left />
          </PageButton>
          {pageNumbers(current, pages).map((n) => (
            <PageButton key={n} label={`Page ${n + 1}`} active={n === current} onClick={() => setPage(n)}>
              {n + 1}
            </PageButton>
          ))}
          <PageButton label="Next page" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            <ChevronIcon />
          </PageButton>
        </nav>
      ) : null}
    </section>
  );
}

/** Up to five page numbers around the current one. */
function pageNumbers(current: number, pages: number): number[] {
  const start = Math.max(0, Math.min(current - 2, pages - 5));
  return Array.from({ length: Math.min(5, pages) }, (_, i) => start + i);
}

function Th({
  children,
  hint,
  active,
  dir,
  sticky = false,
  onClick,
}: {
  children: ReactNode;
  hint: string;
  active: boolean;
  dir: 'asc' | 'desc';
  sticky?: boolean;
  onClick: () => void;
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`${sticky ? 'sticky left-0 z-10 bg-[#12100d] pl-4 sm:pl-5' : 'px-2 sm:px-3'} py-2 pr-2 align-bottom font-sans text-[11.5px] font-medium text-[#a8a29a] sm:pr-3 sm:text-[12px]`}
    >
      <button type="button" title={hint} onClick={onClick} className={`inline-flex max-w-[92px] items-end gap-1 text-left leading-tight hover:text-[#f2ebe1] sm:max-w-none ${active ? 'text-[#f2ebe1]' : ''}`}>
        {children}
        <SortIcon active={active} dir={dir} />
      </button>
    </th>
  );
}

function Cell({ col, value, prev }: { col: Col; value: number | null; prev: number | null }) {
  const delta = (col.kind === 'count' || col.kind === 'total') && value != null && prev != null ? value - prev : 0;
  return (
    <td className="whitespace-nowrap px-2 py-3 align-top font-sans text-[13px] font-semibold text-[#f5f5f5] sm:px-3 sm:text-[13.5px]">
      {fmt(value, col.kind)}
      {col.kind === 'rate' && value != null ? (
        <span className="mt-1.5 block h-[3px] w-14 overflow-hidden rounded-full bg-[#2a2620]" aria-hidden>
          <span className="block h-full rounded-full bg-[#f7d047]" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
        </span>
      ) : null}
      {delta !== 0 ? (
        <span className={`mt-0.5 flex items-center gap-0.5 text-[10.5px] font-medium ${delta > 0 ? 'text-[#5fd38d]' : 'text-[#e0806a]'}`}>
          <ArrowIcon up={delta > 0} size={9} />
          {Math.abs(delta)}
        </span>
      ) : null}
    </td>
  );
}

function fmt(value: number | null, kind: Kind): string {
  if (value == null) return '-';
  if (kind === 'rate') return `${Math.round(value * 1000) / 10}%`;
  return value.toLocaleString('en-US');
}

function PageButton({
  children,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  children: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
      className={`hit-44 flex h-8 min-w-8 items-center justify-center rounded-[8px] px-2 font-sans text-[13px] disabled:opacity-35 ${
        active ? 'border border-[#f7d047] bg-[#2a2413] text-[#f7d047]' : 'bg-[#1a1814] text-[#d4cec4] hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function CountriesCard({ countries, names }: { countries: TractionResult['countries']; names: Record<string, string> }) {
  const total = countries.reduce((n, c) => n + c.accounts, 0) || 1;
  return (
    <section className="rounded-[18px] border border-[#2a2620] bg-[linear-gradient(165deg,#15130f,#0f0e0c)] px-5 py-4">
      <h2 className="m-0 flex items-center gap-3 font-sans text-[18px] font-semibold text-[#f5f5f5]">
        <span className="text-[#f7d047]">
          <GlobeIcon />
        </span>
        Users by country
      </h2>
      <p className="m-0 mt-1 font-sans text-[12px] text-[#8f877c]">From the calling code of a verified phone only.</p>
      <ul className="m-0 mt-3 grid list-none gap-2.5 p-0 sm:grid-cols-2 sm:gap-x-8">
        {countries.map((c) => (
          <li key={c.dial || 'unknown'}>
            <div className="flex items-baseline justify-between gap-3 font-sans text-[13px]">
              <span className="truncate text-[#f2ebe1]">{c.dial ? names[c.dial] || `+${c.dial}` : 'Unknown (no verified phone)'}</span>
              <span className="shrink-0 font-semibold text-[#f5f5f5]">
                {c.accounts} <span className="font-normal text-[#8f877c]">{Math.round((c.accounts / total) * 100)}%</span>
              </span>
            </div>
            <span className="mt-1 block h-[4px] overflow-hidden rounded-full bg-[#221f19]" aria-hidden>
              <span className={`block h-full rounded-full ${c.dial ? 'bg-[#f7d047]' : 'bg-[#5a5348]'}`} style={{ width: `${(c.accounts / total) * 100}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

function UsersIcon() {
  return (
    <Svg>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.4c2.1.7 3.5 2.6 3.5 5.6" />
    </Svg>
  );
}

function BoltIcon() {
  return (
    <Svg>
      <path d="M13 2.5 4.5 13.5h6.5l-1 8 8.5-11h-6.5l1-8Z" />
    </Svg>
  );
}

function WalletIcon() {
  return (
    <Svg>
      <rect x="3" y="5.5" width="18" height="14" rx="2.5" />
      <path d="M3 9.5h18M16 14.5h2" />
    </Svg>
  );
}

function ShieldIcon() {
  return (
    <Svg>
      <path d="M12 2.8 4.5 5.8v5.6c0 4.6 3.1 8.2 7.5 9.8 4.4-1.6 7.5-5.2 7.5-9.8V5.8L12 2.8Z" />
      <path d="m8.8 12 2.2 2.2 4.3-4.4" />
    </Svg>
  );
}

function SparkIcon() {
  return (
    <Svg>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
    </Svg>
  );
}

function CodeIcon() {
  return (
    <Svg>
      <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15" />
    </Svg>
  );
}

function GlobeIcon() {
  return (
    <Svg>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3Z" />
    </Svg>
  );
}

function ArrowIcon({ up, size = 12 }: { up: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {up ? <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" /> : <path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" />}
    </svg>
  );
}

function ChevronIcon({ left = false }: { left?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {left ? <path d="M7.5 2.5 4 6l3.5 3.5" /> : <path d="M4.5 2.5 8 6l-3.5 3.5" />}
    </svg>
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <svg width="9" height="12" viewBox="0 0 9 12" fill="currentColor" aria-hidden className={active ? 'text-[#f7d047]' : 'text-[#5a5348]'}>
      <path d="M4.5 1 8 5H1Z" opacity={active && dir === 'asc' ? 1 : 0.45} />
      <path d="M4.5 11 1 7h7Z" opacity={active && dir === 'desc' ? 1 : 0.45} />
    </svg>
  );
}
