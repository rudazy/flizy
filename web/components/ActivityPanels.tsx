'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { AppSection } from './AppSection';
import { useDashboard } from './DashboardProvider';
import {
  ArrowDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  ExternalLinkIcon,
  NftsIcon,
  SwapArrowsIcon,
} from './ExploreIcons';
import type { ActivityItem } from '../lib/dashboardTypes';
import { shortAddr } from '../lib/dashboardTypes';
import { formatAmount } from '../lib/amountDisplay';
import {
  HISTORY_FILTERS,
  categoryOf,
  groupByDay,
  matchesFilter,
  rowTitle,
  statusPill,
  usdLine,
  type HistoryFilter,
  type Tone,
} from '../lib/historyView';

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
 *
 * Activity: filters (All, Send, Receive, Swap, Claim, NFT), Today / Yesterday /
 * Earlier, one card per move with who, which channel, the amount and its USD
 * value, and a status pill. Tapping a card opens its details and explorer link.
 */

/** The card title, from lib/historyView.ts so both surfaces word it the same. */
function typeBadge(row: ActivityItem) {
  return rowTitle(row);
}

/** The icon circle: money in green, swaps gold, a failed send red, the rest neutral. */
function typeClass(row: ActivityItem) {
  const cat = categoryOf(row);
  if (statusPill(row.status).tone === 'bad') return 'bg-[#2a1414] text-[#f05252]';
  if (row.direction === 'in') return 'bg-[#10261a] text-[#2fd27a]';
  if (cat === 'swap') return 'bg-[#2a2310] text-sun';
  if (cat === 'nft') return 'bg-[#221d14] text-[#e6c88a]';
  if (cat === 'claim') return 'bg-[#1f1c12] text-sun';
  return 'bg-[#1b1c20] text-[#ececec]';
}

function TypeIcon({ row }: { row: ActivityItem }) {
  const cat = categoryOf(row);
  if (cat === 'swap') return <SwapArrowsIcon size={20} />;
  if (cat === 'nft') return <NftsIcon size={20} />;
  if (row.type === 'claim') return <ClockIcon size={20} />;
  return <ArrowDownIcon size={20} className={row.direction === 'in' ? '' : 'rotate-180'} />;
}

const PILL: Record<Tone, string> = {
  good: 'bg-[#10261a] text-[#2fd27a]',
  pending: 'bg-[#2a2310] text-sun',
  bad: 'bg-[#2a1414] text-[#f05252]',
  neutral: 'bg-[#1b1c20] text-[#cfcfcf]',
};

/** One rule, shared with chat via lib/amountDisplay.js. */
const fmtAmt = formatAmount;

function amountLine(row: ActivityItem) {
  const sign = row.direction === 'in' ? '+' : '-';
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

/** Who it was with, or what it was: "From @john", "To 0x2348...5903", "ETH to FLZ", the NFT action. */
function secondaryLine(row: ActivityItem) {
  const cat = categoryOf(row);
  if (cat === 'swap') {
    return row.assetSecondary ? `${row.asset} → ${row.assetSecondary}` : row.label;
  }
  if (cat === 'nft') return row.label;
  if (row.type === 'claim') return row.label;
  const who = row.counterparty
    ? row.counterparty.startsWith('0x')
      ? shortAddr(row.counterparty)
      : row.counterparty
    : null;
  if (row.direction === 'in') {
    // A received row's label carries the payer ("Received 0.01 ETH from @john").
    const from = row.label.match(/ from (.+)$/);
    return from ? `From ${from[1]}` : 'Received';
  }
  return who ? `To ${who}` : row.label;
}

type Props = {
  /**
   * Whether the empty state offers a link to Wallet. False on the Wallet slide,
   * where it would send someone to the page they are already reading.
   */
  showWalletLink?: boolean;
};

export function ActivityPanels({ showWalletLink = true }: Props) {
  const { activity, waiting, history, explorerBase, historyUsdPerEth } = useDashboard();
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [open, setOpen] = useState<string | null>(null);

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

  const visible = rows.filter((row) => matchesFilter(row, filter));

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

      <section className="grid gap-[12px]" aria-label="Activity">
        <div className="-mx-1 flex gap-[6px] overflow-x-auto px-1 pb-[2px] [scrollbar-width:none]" role="tablist" aria-label="Filter history">
          {HISTORY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`hit-y-44 h-[32px] shrink-0 rounded-full border px-[11px] font-sans text-[12.5px] ${
                filter === f.id ? 'border-sun bg-sun font-semibold text-[#1a1405]' : 'border-[#2a2b30] text-[#d6d6d6] hover:text-white'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[16px]">
            <p className="m-0 text-xs leading-relaxed text-muted">Nothing yet. After chat or Swap, moves land here.</p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Link href="/dashboard/swap" className="btn btn-primary flex-1 text-sm no-underline">
                Open Swap
              </Link>
              {showWalletLink ? (
                <Link href="/dashboard/wallet" className="btn btn-ghost flex-1 text-sm no-underline">
                  Wallet
                </Link>
              ) : null}
            </div>
          </div>
        ) : visible.length === 0 ? (
          <p className="m-0 font-sans text-[12.5px] text-[#a9a9a9]">
            Nothing under {HISTORY_FILTERS.find((f) => f.id === filter)?.label} yet.
          </p>
        ) : (
          groupByDay(visible).map((group) => (
            <div key={group.key} className="grid gap-[10px]">
              <h3 className="m-0 font-sans text-[15px] font-semibold text-[#9a9a9a]">{group.label}</h3>
              {group.rows.map((row) => (
                <HistoryCard
                  key={row.id}
                  row={row}
                  usdPerEth={historyUsdPerEth}
                  explorerBase={explorerBase}
                  open={open === row.id}
                  onToggle={() => setOpen((cur) => (cur === row.id ? null : row.id))}
                />
              ))}
            </div>
          ))
        )}
      </section>
    </>
  );
}

/** One move: icon, what it was, who with, amount and status; tap for the details. */
function HistoryCard({
  row,
  usdPerEth,
  explorerBase,
  open,
  onToggle,
}: {
  row: ActivityItem;
  usdPerEth: number | null;
  explorerBase: string;
  open: boolean;
  onToggle: () => void;
}) {
  const pill = statusPill(row.status);
  const cat = categoryOf(row);
  const hasAmount = Number(row.amount) > 0;
  const usd = usdLine(row.amount, row.asset, usdPerEth);
  // A wallet the reader sent to is theirs to see and copy; nothing about the other side of a received row.
  const address =
    row.direction === 'out' && cat === 'send' && row.counterparty && /^0x[0-9a-fA-F]{40}$/.test(row.counterparty)
      ? row.counterparty
      : null;
  const detailsId = `history-${row.id}`;

  return (
    <article className="rounded-[14px] border border-[#23242a] bg-[#0d0d0e]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailsId}
        className="flex w-full items-center gap-[12px] p-[14px] text-left"
      >
        <span className={`flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full ${typeClass(row)}`} aria-hidden>
          <TypeIcon row={row} />
        </span>
        <span className="grid min-w-0 flex-1 gap-[3px]">
          <span className="font-sans text-[15px] font-semibold text-white">{typeBadge(row)}</span>
          <span className="flex min-w-0 items-center gap-[6px] font-sans text-[13px] text-[#bdbdbd]">
            <span className="truncate">{secondaryLine(row)}</span>
            {row.channel && row.direction === 'in' && cat !== 'swap' ? (
              <span className="shrink-0 text-[#8d8d8d]">· {row.channel}</span>
            ) : null}
            {cat === 'swap' ? <SwapArrowsIcon size={13} className="shrink-0 text-[#8d8d8d]" /> : null}
          </span>
          {row.note ? <span className="truncate font-sans text-[12px] text-[#9a9a9a]">{row.note}</span> : null}
          <span className="font-sans text-[12px] text-[#8d8d8d]">{relativeTime(row.createdAt)}</span>
        </span>
        <span className="grid shrink-0 justify-items-end gap-[4px]">
          {hasAmount ? (
            <span className={`font-sans text-[15px] font-semibold ${row.direction === 'in' ? 'text-[#2fd27a]' : 'text-white'}`}>
              {amountLine(row)}
            </span>
          ) : null}
          {cat === 'swap' && row.amountSecondary && row.assetSecondary ? (
            <span className="font-sans text-[12.5px] text-[#a9a9a9]">
              +{fmtAmt(row.amountSecondary)} {row.assetSecondary}
            </span>
          ) : usd ? (
            <span className="font-sans text-[12.5px] text-[#a9a9a9]">{usd}</span>
          ) : null}
          <span className={`rounded-[6px] px-[9px] py-[2px] font-sans text-[11.5px] ${PILL[pill.tone]}`}>{pill.label}</span>
        </span>
        <ChevronRightIcon size={15} className={`shrink-0 text-[#8d8d8d] transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>

      {open ? (
        <div id={detailsId} className="grid gap-[8px] border-t border-[#1f1f22] px-[14px] pb-[14px] pt-[12px] font-sans text-[12px]">
          <Detail label="What" value={row.label} />
          {row.channel ? <Detail label="Channel" value={row.channel} /> : null}
          {address ? (
            <Detail
              label="To"
              value={
                <span className="inline-flex items-center gap-[6px]">
                  <span className="font-mono">{shortAddr(address)}</span>
                  <CopyAddress value={address} />
                </span>
              }
            />
          ) : null}
          <Detail label="Status" value={pill.label} />
          <Detail label="When" value={new Date(row.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} />
          {row.txHash && explorerBase ? (
            <a
              href={`${explorerBase}/tx/${row.txHash}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-[6px] justify-self-start text-sun no-underline"
            >
              View on explorer <ExternalLinkIcon size={12} />
            </a>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-[12px]">
      <span className="shrink-0 text-[#8d8d8d]">{label}</span>
      <span className="min-w-0 break-words text-right text-[#e6e6e6]">{value}</span>
    </div>
  );
}

function CopyAddress({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={copied ? 'Address copied' : 'Copy address'}
      className="hit-44 text-[#bdbdbd] hover:text-white"
    >
      {copied ? 'Copied' : <CopyIcon size={13} />}
    </button>
  );
}
