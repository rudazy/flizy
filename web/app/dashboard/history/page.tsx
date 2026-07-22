'use client';

import { AppTopBar } from '../../../components/AppTopBar';
import { useDashboard } from '../../../components/DashboardProvider';
import { shortAddr } from '../../../lib/dashboardTypes';

export default function HistoryPage() {
  const { history, explorerBase, refreshing, refreshAll } = useDashboard();

  return (
    <div className="space-y-5">
      <AppTopBar
        title="History"
        actionLabel={refreshing ? '...' : 'Refresh'}
        onAction={refreshAll}
        actionBusy={refreshing}
      />

      <section className="card p-4">
        <p className="mb-4 text-sm text-muted">
          Same last transfers as <span className="text-paper">flizy history</span> on WhatsApp.
        </p>

        {history.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
            <p className="font-sans text-sm text-paper">No transfers yet</p>
            <p className="mt-2 text-xs text-muted">
              After you send on WhatsApp, rows appear here with explorer links.
            </p>
          </div>
        ) : (
          <ul className="space-y-0">
            {history.map((row) => (
              <li
                key={row.id}
                className="border-b border-border py-4 text-sm first:pt-0 last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-sans text-base text-lime">{row.amount_eth} ETH</span>
                  <span className="badge">{row.status}</span>
                </div>
                <p className="mt-1 text-xs text-muted">To {shortAddr(row.to_address)}</p>
                <p className="text-xs text-muted">{new Date(row.created_at).toLocaleString()}</p>
                {row.tx_hash ? (
                  <a
                    className="mt-2 inline-block text-xs text-lime no-underline hover:text-gold"
                    href={`${explorerBase}/tx/${row.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View tx
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
