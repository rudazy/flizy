'use client';

import Link from 'next/link';
import { AppSection } from './AppSection';
import { useDashboard } from './DashboardProvider';
import type { ActivityItem } from '../lib/dashboardTypes';
import { shortAddr } from '../lib/dashboardTypes';
import { formatAmount } from '../lib/amountDisplay';

/**
 * Waiting-for-you and Activity, as one pair of panels.
 *
 * Extracted from app/dashboard/history/page.tsx when history became a Wallet
 * slide as well as a tab. Two surfaces now render the same thing, and the point
 * of a single component is that they cannot drift: a badge colour or a status
 * line fixed in one place is fixed in both, which a copy would not give.
 *
 * It renders no top bar. Each host supplies its own, because the tab is a page
 * with a title and the slide sits under the Wallet bar.
 */

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
  if (type === 'receive') return 'border-lime/35 bg-lime/10 text-lime';
  if (type === 'swap') return 'border-gold/35 bg-gold/10 text-gold';
  if (type === 'claim') return 'border-border bg-ink text-paper';
  if (type === 'withdraw') return 'border-border bg-ink text-muted';
  return 'border-border bg-ink text-muted';
}

/** One rule, shared with chat via lib/amountDisplay.js. */
const fmtAmt = formatAmount;

function amountLine(row: ActivityItem) {
  if (row.type === 'swap' && row.amountSecondary && row.assetSecondary) {
    return `${fmtAmt(row.amount)} ${row.asset} → ${fmtAmt(row.amountSecondary)} ${row.assetSecondary}`;
  }
  const sign = row.direction === 'in' ? '+' : '−';
  return `${sign}${fmtAmt(row.amount)} ${row.asset}`;
}

function relativeTime(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function secondaryLine(row: ActivityItem) {
  if (row.type === 'swap') {
    return row.label.startsWith('Swap') || row.label.includes('→')
      ? row.label
      : `Swap · ${row.status}`;
  }
  if (row.counterparty) {
    const c = row.counterparty.startsWith('0x')
      ? shortAddr(row.counterparty)
      : row.counterparty;
    if (row.type === 'claim') return row.label.includes(c) ? row.label : `${row.label}`;
    return c;
  }
  return row.label;
}

type Props = {
  /**
   * Whether the empty state offers a link to Wallet. False on the Wallet slide,
   * where it would send someone to the page they are already reading.
   */
  showWalletLink?: boolean;
};

export function ActivityPanels({ showWalletLink = true }: Props) {
  const { activity, waiting, history, explorerBase } = useDashboard();

  const rows: ActivityItem[] =
    activity.length > 0
      ? activity
      : history.map((row) => ({
          id: row.id,
          type: (row.kind === 'swap' ? 'swap' : 'transfer') as ActivityItem['type'],
          direction: 'out' as const,
          amount: row.amount_eth,
          asset: row.asset || 'ETH',
          status: row.status,
          txHash: row.tx_hash,
          createdAt: row.created_at,
          label: `Sent ${row.amount_eth} ${row.asset || 'ETH'}`,
          counterparty: row.to_address,
        }));

  return (
    <>
      {waiting.length > 0 ? (
        <AppSection
          title="Waiting for you"
          helper="Money already sent to you that has not been collected yet."
          badge={String(waiting.length)}
        >
          <ul className="space-y-2">
            {waiting.map((c) => (
              <li
                key={c.id}
                className="flex items-center justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="font-sans text-sm tracking-wide text-paper">{c.label}</p>
                  {c.counterparty ? (
                    <p className="mt-0.5 text-xs text-muted">{c.counterparty}</p>
                  ) : null}
                </div>
                {c.canClaimOnWeb && c.claimToken ? (
                  <Link
                    href={`/claim/${c.claimToken}`}
                    className="shrink-0 text-xs text-lime no-underline hover:text-gold"
                  >
                    Claim →
                  </Link>
                ) : (
                  <span className="shrink-0 text-xs text-muted">Claim in chat</span>
                )}
              </li>
            ))}
          </ul>
        </AppSection>
      ) : null}

      <AppSection
        title="Activity"
        helper="Sends, claims, swaps, requests. One row shape for everything."
        badge={rows.length === 0 ? 'Empty' : `${rows.length}`}
      >
        {rows.length === 0 ? (
          <>
            <p className="text-xs leading-relaxed text-muted">
              Nothing yet. After chat or Swap, moves land here.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Link href="/dashboard/swap" className="btn btn-primary flex-1 text-sm no-underline">
                Open Swap
              </Link>
              {showWalletLink ? (
                <Link
                  href="/dashboard/wallet"
                  className="btn btn-ghost flex-1 text-sm no-underline"
                >
                  Wallet
                </Link>
              ) : null}
            </div>
          </>
        ) : (
          <ul className="-mx-4 -mb-4 divide-y divide-border sm:-mx-5 sm:-mb-5">
            {rows.map((row) => (
              <li key={row.id} className="px-4 py-3 sm:px-5">
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 inline-flex shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ${typeClass(row.type)}`}
                  >
                    {typeBadge(row.type)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className={`font-sans text-[15px] tracking-wide ${
                          row.direction === 'in' ? 'text-lime' : 'text-paper'
                        }`}
                      >
                        {amountLine(row)}
                      </p>
                      <span className="shrink-0 font-mono text-[10px] text-muted">
                        {relativeTime(row.createdAt)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted">{secondaryLine(row)}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">
                        {row.status}
                      </span>
                      {row.txHash ? (
                        <a
                          className="font-mono text-[10px] text-lime no-underline hover:text-gold"
                          href={`${explorerBase}/tx/${row.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View tx
                        </a>
                      ) : null}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AppSection>
    </>
  );
}
