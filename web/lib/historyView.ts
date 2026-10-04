/**
 * How History draws a row: its filter, title, status pill and day group.
 * Pure (no React, no fetch), so test/historyView.test.js loads it directly and
 * the Wallet slide and the History tab, which share ActivityPanels, agree.
 */

import type { ActivityItem } from './dashboardTypes';

export type HistoryFilter = 'all' | 'send' | 'receive' | 'swap' | 'claim' | 'nft';

export const HISTORY_FILTERS: Array<{ id: HistoryFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'send', label: 'Send' },
  { id: 'receive', label: 'Receive' },
  { id: 'swap', label: 'Swap' },
  { id: 'claim', label: 'Claim' },
  { id: 'nft', label: 'NFT' },
];

/** The row's filter. Older responses without a category fall back to the row type. */
export function categoryOf(row: ActivityItem): Exclude<HistoryFilter, 'all'> {
  if (row.category) return row.category;
  if (row.type === 'swap') return 'swap';
  if (row.type === 'claim') return 'claim';
  if (row.type === 'receive') return 'receive';
  return 'send';
}

export function matchesFilter(row: ActivityItem, filter: HistoryFilter): boolean {
  return filter === 'all' || categoryOf(row) === filter;
}

export type Tone = 'good' | 'pending' | 'bad' | 'neutral';

/** The pill on the right: words a person reads, with a tone. */
export function statusPill(status: string): { label: string; tone: Tone } {
  const s = String(status || '').toLowerCase();
  if (['confirmed', 'success', 'succeeded', 'completed', 'complete', 'sent'].includes(s)) return { label: 'Confirmed', tone: 'good' };
  if (s === 'claimed') return { label: 'Claimed', tone: 'good' };
  if (['pending', 'processing', 'held', 'submitted', 'queued'].includes(s)) return { label: 'Pending', tone: 'pending' };
  if (['failed', 'error', 'reverted'].includes(s)) return { label: 'Failed', tone: 'bad' };
  if (s === 'cancelled' || s === 'canceled' || s === 'refunded') return { label: 'Refunded', tone: 'neutral' };
  if (s === 'expired') return { label: 'Expired', tone: 'neutral' };
  return { label: s ? s[0].toUpperCase() + s.slice(1) : 'Unknown', tone: 'neutral' };
}

/**
 * NFT rows are titled from the label the marketplace and mint routes log
 * (web/app/api/market/[action]/route.ts, web/app/api/mints/). The more
 * specific prefixes come first: "Cancel offer" before "Offer".
 */
const NFT_TITLES: Array<[RegExp, string]> = [
  [/^Cancel offer/, 'Offer Cancelled'],
  [/^Cancel listing/, 'Listing Cancelled'],
  [/^Mint /, 'NFT Mint'],
  [/^Buy /, 'NFT Bought'],
  [/^Sell /, 'NFT Sold'],
  [/^Offer /, 'NFT Offer'],
  [/^List /, 'NFT Listed'],
  [/^Withdraw /, 'Sale Proceeds'],
  [/^Set .* royalty/, 'Royalty Set'],
  [/^Set up mint/, 'Mint Set Up'],
  [/^Publish allowlist/, 'Allowlist Published'],
  [/^Pause mint/, 'Mint Paused'],
  [/^Resume mint/, 'Mint Resumed'],
  [/^Create collection/, 'Collection Created'],
];

/** "Received", "Sent", "Swap", "Claim", "NFT Offer", "Withdraw", "Refund". */
export function rowTitle(row: ActivityItem): string {
  const cat = categoryOf(row);
  if (cat === 'nft') return NFT_TITLES.find(([re]) => re.test(row.label))?.[1] ?? 'NFT';
  if (cat === 'swap') return 'Swap';
  if (row.type === 'withdraw') return 'Withdraw';
  if (row.type === 'claim') return 'Claim';
  if (row.direction === 'in') return String(row.status).toLowerCase() === 'cancelled' ? 'Refund' : 'Received';
  return 'Sent';
}

export type DayGroup = { key: 'today' | 'yesterday' | 'earlier'; label: string; rows: ActivityItem[] };

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Today, Yesterday and Earlier, by the viewer's local calendar day, newest first inside each. */
export function groupByDay(rows: ActivityItem[], nowMs = Date.now()): DayGroup[] {
  const today = dayStart(nowMs);
  const yesterday = today - 86_400_000;
  const groups: DayGroup[] = [
    { key: 'today', label: 'Today', rows: [] },
    { key: 'yesterday', label: 'Yesterday', rows: [] },
    { key: 'earlier', label: 'Earlier', rows: [] },
  ];
  const sorted = [...rows].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const row of sorted) {
    const t = Date.parse(row.createdAt);
    if (Number.isFinite(t) && t >= today) groups[0].rows.push(row);
    else if (Number.isFinite(t) && t >= yesterday) groups[1].rows.push(row);
    else groups[2].rows.push(row);
  }
  return groups.filter((g) => g.rows.length > 0);
}

/**
 * The approximate USD value of an ETH amount, drawn with the approx sign, or
 * null for other assets, zero amounts or no rate.
 */
export function usdLine(amount: string | number, asset: string, usdPerEth: number | null): string | null {
  if (usdPerEth == null || String(asset).toUpperCase() !== 'ETH') return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const usd = n * usdPerEth;
  return `≈ $${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
