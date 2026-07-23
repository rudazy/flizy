'use client';

import { AppTopBar } from '../../../components/AppTopBar';
import { useDashboard } from '../../../components/DashboardProvider';
import type { ActivityItem } from '../../../lib/dashboardTypes';
import { shortAddr } from '../../../lib/dashboardTypes';

function typeBadge(type: ActivityItem['type']) {
  const map: Record<ActivityItem['type'], string> = {
    transfer: 'Send',
    receive: 'Receive',
    claim: 'Claim',
    swap: 'Swap',
    withdraw: 'Withdraw',
  };
  return map[type] || type;
}

function typeClass(type: ActivityItem['type']) {
  if (type === 'receive') return 'text-lime border-lime/30';
  if (type === 'swap') return 'text-gold border-gold/30';
  if (type === 'claim') return 'text-paper border-border';
  return 'text-muted border-border';
}

function amountLine(row: ActivityItem) {
  if (row.type === 'swap' && row.amountSecondary && row.assetSecondary) {
    return `${fmtAmt(row.amount)} ${row.asset} → ${fmtAmt(row.amountSecondary)} ${row.assetSecondary}`;
  }
  const sign = row.direction === 'in' ? '+' : '−';
  return `${sign}${fmtAmt(row.amount)} ${row.asset}`;
}

function fmtAmt(n: string | number) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  if (x === 0) return '0';
  if (x >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (x < 0.000001) return x.toExponential(3);
  return x.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export default function HistoryPage() {
  const { activity, history, explorerBase, refreshing, refreshAll } = useDashboard();
  // Prefer unified activity feed when present; fall back to legacy transfer rows
  const rows = activity.length > 0 ? activity : history.length === 0 ? [] : null;

  return (
    <div className="space-y-5">
      <AppTopBar
        title="History"
        actionLabel={refreshing ? '...' : 'Refresh'}
        onAction={refreshAll}
        actionBusy={refreshing}
      />

      <section className="card p-4">
        <p className="mb-1 text-sm text-muted">
          Last 30 activity rows — sends, receives, claims, and swaps.
        </p>
        <p className="mb-4 text-xs text-muted">
          Same desk as WhatsApp <span className="text-paper">flizy history</span>. Scroll the list.
        </p>

        {rows && rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
            <p className="font-sans text-sm text-paper">No activity yet</p>
            <p className="mt-2 text-xs text-muted">
              Send, swap, or claim on WhatsApp — rows show up here with explorer links.
            </p>
          </div>
        ) : rows ? (
          <div className="max-h-[min(70vh,640px)] overflow-y-auto overscroll-contain pr-1">
            <ul className="space-y-0">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="border-b border-border py-4 text-sm first:pt-0 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${typeClass(row.type)}`}
                    >
                      {typeBadge(row.type)}
                    </span>
                    <span className="badge">{row.status}</span>
                  </div>
                  <p
                    className={`mt-2 font-sans text-base tracking-wide ${
                      row.direction === 'in' ? 'text-lime' : 'text-paper'
                    }`}
                  >
                    {amountLine(row)}
                  </p>
                  <p className="mt-1 text-xs text-muted">{row.label}</p>
                  {row.counterparty && row.type !== 'swap' ? (
                    <p className="text-xs text-muted">
                      {row.counterparty.startsWith('0x')
                        ? shortAddr(row.counterparty)
                        : row.counterparty}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted">{new Date(row.createdAt).toLocaleString()}</p>
                  {row.txHash ? (
                    <a
                      className="mt-2 inline-block text-xs text-lime no-underline hover:text-gold"
                      href={`${explorerBase}/tx/${row.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View tx
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : history.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
            <p className="font-sans text-sm text-paper">No activity yet</p>
            <p className="mt-2 text-xs text-muted">
              After you send or swap, rows appear here with explorer links.
            </p>
          </div>
        ) : (
          <div className="max-h-[min(70vh,640px)] overflow-y-auto overscroll-contain pr-1">
            <ul className="space-y-0">
              {history.map((row) => (
                <li
                  key={row.id}
                  className="border-b border-border py-4 text-sm first:pt-0 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-sans text-base text-lime">
                      {row.amount_eth} {row.asset || 'ETH'}
                    </span>
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
          </div>
        )}
      </section>
    </div>
  );
}
