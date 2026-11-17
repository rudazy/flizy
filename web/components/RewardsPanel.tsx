'use client';

import { useEffect, useState } from 'react';
import { AppSection } from './AppSection';

type RewardsView = {
  points: string;
  entries: Array<{ at: string; label: string; points: string }>;
  more: boolean;
  note: string;
  howToEarn: string;
};

function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Account > Rewards: the points balance and the latest entries
 * (/api/account/rewards). Read only.
 */
export function RewardsPanel() {
  const [view, setView] = useState<RewardsView | null>(null);
  const [msg, setMsg] = useState('');

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

  return (
    <AppSection title="Rewards" helper="Points you earn from Flizy fees.">
      {!view ? (
        <p className="mt-4 text-sm text-muted">{msg || 'Loading...'}</p>
      ) : (
        <div className="mt-4 grid gap-4">
          <div className="rounded-[4px] border border-[#1f1f1f] bg-[#111111] p-4">
            <p className="m-0 font-sans text-xs uppercase tracking-[0.08em] text-muted">Balance</p>
            <p className="m-0 mt-2 font-sans text-3xl font-semibold tracking-wide text-paper">
              {view.points} <span className="text-base font-normal text-muted">points</span>
            </p>
            <p className="m-0 mt-2 text-xs text-muted">{view.note}</p>
          </div>

          {view.entries.length ? (
            <ul className="m-0 grid list-none gap-0 p-0">
              {view.entries.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex items-baseline justify-between gap-4 border-b border-[#1f1f1f] py-3 text-sm last:border-b-0">
                  <span className="min-w-0">
                    <span className="block text-paper">{e.label}</span>
                    <span className="block text-xs text-muted">{day(e.at)}</span>
                  </span>
                  <span className="shrink-0 text-sun">
                    {e.points.startsWith('-') ? '' : '+'}
                    {e.points}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid gap-1 text-sm">
              <p className="m-0 text-paper">No rewards yet.</p>
              <p className="m-0 text-muted">{view.howToEarn}</p>
            </div>
          )}
          {view.more ? <p className="m-0 text-xs text-muted">Showing your latest rewards.</p> : null}
        </div>
      )}
    </AppSection>
  );
}
