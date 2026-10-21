'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppPage } from '../../../components/AppSection';
import { ShareReceiptButton } from '../../../components/ShareReceiptButton';

/**
 * Get paid: what came into this wallet, totals per asset, a CSV for the books,
 * and a refund that goes back through the ordinary pay page (PIN, limits and
 * notices included). Data from GET /api/payments/received.
 */

type Payment = {
  id: string;
  at: string;
  amount: string;
  unit: string;
  from: string;
  note: string | null;
  txHash: string | null;
  refundUrl: string | null;
};

type Data = { days: number; truncated: boolean; totals: Array<{ unit: string; total: string; count: number }>; payments: Payment[] };

const WINDOWS = [30, 90, 365] as const;
const CARD = 'rounded-[14px] border border-[#232323] bg-[#101010]';

export default function ReceivedPage() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/payments/received?days=${days}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !Array.isArray(body.payments)) {
        setError(body?.error || 'Could not load payments.');
        return;
      }
      setData(body as Data);
    } catch {
      setError('Could not load payments.');
    } finally {
      setBusy(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <AppPage>
      <AppTopBar title="Get paid" actionLabel="Refresh" onAction={() => void load()} actionBusy={busy} />

      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Window">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`hit-y-44 h-9 rounded-[8px] border px-3 font-sans text-[13px] ${
                days === d ? 'border-sun/70 text-sun' : 'border-[#3a3a3e] text-[#d9d4ca] hover:text-white'
              }`}
            >
              {d} days
            </button>
          ))}
          <a
            href={`/api/payments/received?days=${days}&format=csv`}
            className="hit-y-44 ml-auto inline-flex h-9 items-center rounded-[8px] border border-[#3a3a3e] px-3 font-sans text-[13px] text-[#f5f5f5] no-underline hover:border-[#5a5a5a]"
          >
            Download CSV
          </a>
        </div>

        {error ? (
          <p className="m-0 text-sm text-[#e0b070]" role="alert">
            {error}
          </p>
        ) : null}

        {data ? (
          <>
            <section className={`${CARD} grid gap-3 p-5 sm:grid-cols-3`}>
              {data.totals.length ? (
                data.totals.map((t) => (
                  <div key={t.unit}>
                    <p className="m-0 font-sans text-[11px] uppercase tracking-[0.16em] text-[#8f8f8f]">
                      {t.unit}, {t.count} {t.count === 1 ? 'payment' : 'payments'}
                    </p>
                    <p className="m-0 mt-1 font-sans text-3xl font-semibold tracking-wide text-[#f5f5f5]">{t.total}</p>
                  </div>
                ))
              ) : (
                <p className="m-0 text-sm text-muted">Nothing received in the last {data.days} days.</p>
              )}
            </section>

            <ul className="m-0 grid list-none gap-2 p-0">
              {data.payments.map((p) => (
                <li key={p.id} className={`${CARD} grid gap-2 p-4`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="m-0 truncate font-sans text-[15px] font-semibold text-white">{p.from}</p>
                      {p.note ? <p className="m-0 truncate font-sans text-[12.5px] text-[#9a9a9a]">{p.note}</p> : null}
                      <p className="m-0 font-sans text-[12px] text-[#8d8d8d]">
                        {new Date(p.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                      </p>
                    </div>
                    <p className="m-0 shrink-0 font-sans text-[15px] font-semibold text-[#2fd27a]">
                      +{p.amount} {p.unit}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-4 font-sans text-[12.5px]">
                    <ShareReceiptButton transferId={p.id} className="text-sun disabled:opacity-60" />
                    {p.refundUrl ? (
                      <a href={p.refundUrl} className="text-[#d9d4ca] no-underline hover:text-white">
                        Refund
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {data.truncated ? <p className="m-0 text-xs text-muted">Showing the newest 1000. Download the CSV or pick a shorter window.</p> : null}
          </>
        ) : !error ? (
          <div className={`${CARD} h-[160px] animate-pulse`} aria-busy="true" aria-label="Loading payments" />
        ) : null}
      </div>
    </AppPage>
  );
}
