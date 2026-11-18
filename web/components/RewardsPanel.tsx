'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDownIcon, GiftIcon, InfoIcon, StoreIcon, SwapArrowsIcon, UserPlusIcon, WalletIcon } from './ExploreIcons';

/** What an entry was for (lib/rewardsView.js entryKind). */
type EntryKind = 'swap' | 'payment' | 'referral' | 'business' | 'adjustment';

type RewardsView = {
  points: string;
  entries: Array<{ at: string; kind: EntryKind; label: string; points: string }>;
  more: boolean;
  note: string;
  howToEarn: string;
};

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const ICONS: Record<EntryKind, ReactNode> = {
  swap: <SwapArrowsIcon size={20} />,
  payment: <WalletIcon size={20} />,
  referral: <UserPlusIcon size={20} />,
  business: <StoreIcon size={20} />,
  adjustment: <GiftIcon size={20} />,
};

/** The activity filter: which entry kinds each choice shows. */
const FILTERS: ReadonlyArray<{ id: string; label: string; kinds: readonly EntryKind[] | null }> = [
  { id: 'all', label: 'All activity', kinds: null },
  { id: 'cashback', label: 'Cashback', kinds: ['swap', 'payment'] },
  { id: 'referral', label: 'Referrals', kinds: ['referral'] },
  { id: 'business', label: 'Business', kinds: ['business'] },
];

/**
 * Account > Rewards: the points balance and the latest entries
 * (/api/account/rewards). Read only.
 */
export function RewardsPanel() {
  const [view, setView] = useState<RewardsView | null>(null);
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let live = true;
    fetch('/api/account/rewards', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (!res.ok) setMsg(body.error || 'Could not load your rewards. Try again shortly.');
        else setView(body);
      })
      .catch(() => live && setMsg('Could not load your rewards. Try again shortly.'));
    return () => {
      live = false;
    };
  }, []);

  const kinds = FILTERS.find((f) => f.id === filter)?.kinds || null;
  const shown = view ? view.entries.filter((e) => !kinds || kinds.includes(e.kind)) : [];

  return (
    <section role="tabpanel" className="flex grow flex-col gap-4 font-sans md:grow-0">
      <header className="px-1 pt-2">
        <p className="m-0 font-sans text-[11px] font-medium uppercase tracking-[0.22em] text-[#bdb6ab]">Rewards</p>
        <h2 className="m-0 mt-2 font-sans text-[26px] font-semibold leading-tight tracking-wide text-paper">Your rewards</h2>
        <p className="m-0 mt-1 text-sm text-muted">Points you earn from Flizy fees.</p>
      </header>

      {!view ? (
        <div className="rounded-[10px] border border-chrome-line bg-[#0e0e0f] p-4">
          <p className="m-0 text-sm text-muted">{msg || 'Loading...'}</p>
        </div>
      ) : (
        <>
          <div className="relative overflow-hidden rounded-[10px] border border-sun/25 bg-[linear-gradient(135deg,#16140d_0%,#0e0d0a_60%,#0b0a09_100%)] p-5">
            <span
              aria-hidden
              className="pointer-events-none absolute -right-[460px] -top-10 h-[520px] w-[520px] rounded-full border border-sun/45 shadow-[0_0_48px_rgba(247,208,71,0.16)]"
            />
            <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_90%_40%,rgba(247,208,71,0.10),transparent_55%)]" />
            <div className="relative">
              <p className="m-0 text-sm text-[#bdb6ab]">Total balance</p>
              <p className="m-0 mt-1 break-all font-sans text-[40px] font-semibold leading-tight tracking-wide text-paper">
                {view.points} <span className="text-lg font-normal text-muted">points</span>
              </p>
              <p className="m-0 mt-3 inline-flex items-center gap-2 rounded-[8px] border border-chrome-line bg-[#0d0c0a] px-3 py-1.5 text-xs text-[#d0c9be]">
                <InfoIcon size={16} />
                {view.note}
              </p>
            </div>
          </div>

          <div className="rounded-[10px] border border-chrome-line bg-[#0e0e0f] p-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="m-0 font-sans text-lg font-semibold tracking-wide text-paper">Recent activity</h3>
              {view.entries.length ? (
                <label className="relative shrink-0">
                  <span className="sr-only">Show</span>
                  <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="hit-y-44 h-9 appearance-none rounded-[8px] border border-chrome-line bg-[#111113] py-0 pl-3 pr-8 font-sans text-[13px] text-paper"
                  >
                    {FILTERS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDownIcon size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-paper" />
                </label>
              ) : null}
            </div>

            {!view.entries.length ? (
              <div className="mt-3 grid gap-1 text-sm">
                <p className="m-0 text-paper">No rewards yet.</p>
                <p className="m-0 text-muted">{view.howToEarn}</p>
              </div>
            ) : shown.length ? (
              <ul className="m-0 mt-4 grid list-none gap-2 p-0">
                {shown.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex items-center gap-3 rounded-[8px] border border-chrome-line bg-[#111113] p-3">
                    <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-sun/15 bg-sun-wash text-sun">
                      {ICONS[e.kind] || ICONS.adjustment}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-paper">{e.label}</span>
                      <span className="block text-xs text-muted">{day(e.at)}</span>
                    </span>
                    <span className="shrink-0 text-sm font-medium text-sun">
                      {e.points.startsWith('-') ? '' : '+'}
                      {e.points} points
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 mt-3 text-sm text-muted">Nothing of this kind in your latest rewards.</p>
            )}
            {view.more ? <p className="m-0 mt-3 text-xs text-muted">Showing your latest rewards.</p> : null}
          </div>
        </>
      )}
    </section>
  );
}
