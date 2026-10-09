/**
 * Wallet Scan: range, totals, chips, search and the words on a row.
 * Pure (no React, no fetch). The screen reads the Flizy-wide feed, which is
 * the latest moves from every account, so a figure here is not a lifetime
 * total. Volume is a dollar amount only when every settled row in the window
 * is ETH and a rate exists. An empty window,
 * or one with no settled ETH, is $0.00. A settled row in another asset, or
 * settled ETH with no rate, is a hyphen. Failed rows stay in the counts and
 * stay out of the volume.
 */

import { formatAmount } from './amountDisplay.ts';
import { shortAddr, type ActivityItem } from './dashboardTypes.ts';
import { categoryOf, statusPill, type Tone } from './historyView.ts';

export type ScanRange = '24h' | '7d' | '30d' | 'all' | 'custom';
export type ScanChip = 'all' | 'swap' | 'send' | 'receive' | 'pool' | 'nft' | 'other';
export type ScanSort = 'latest' | 'oldest';
export type ScanStatus = 'all' | Tone;

export const SCAN_RANGES: Array<{ id: Exclude<ScanRange, 'custom'>; label: string }> = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: 'all', label: 'All time' },
];

export const SCAN_CHIPS: Array<{ id: ScanChip; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'swap', label: 'Swaps' },
  { id: 'send', label: 'Sends' },
  { id: 'receive', label: 'Receives' },
  { id: 'pool', label: 'Pools' },
  { id: 'nft', label: 'NFTs' },
  { id: 'other', label: 'Other' },
];

export const SCAN_STATUSES: Array<{ id: ScanStatus; label: string }> = [
  { id: 'all', label: 'All statuses' },
  { id: 'good', label: 'Confirmed' },
  { id: 'pending', label: 'Pending' },
  { id: 'bad', label: 'Failed' },
  { id: 'neutral', label: 'Other status' },
];

export const SCAN_SORTS: Array<{ id: ScanSort; label: string }> = [
  { id: 'latest', label: 'Latest first' },
  { id: 'oldest', label: 'Oldest first' },
];

const HOUR = 3_600_000;
const DAY = 86_400_000;

export type ScanWindow = { start: number; end: number; endExclusive?: boolean };

/** Local calendar day from a YYYY-MM-DD value. Invalid dates return null. */
function parseDay(isoDate: string, end: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

/** The inclusive window a range covers. Custom with no usable date returns null. */
export function scanWindow(range: ScanRange, now: number, from = '', to = ''): ScanWindow | null {
  if (range === 'all') return { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY };
  if (range === '24h') return { start: now - 24 * HOUR, end: now };
  if (range === '7d') return { start: now - 7 * DAY, end: now };
  if (range === '30d') return { start: now - 30 * DAY, end: now };
  if (range !== 'custom' || (!from && !to)) return null;

  const start = from ? parseDay(from, false) : Number.NEGATIVE_INFINITY;
  const end = to ? parseDay(to, true) : Number.POSITIVE_INFINITY;
  if (start == null || end == null) return null;
  if (start <= end) return { start, end };
  const swappedStart = to ? parseDay(to, false) : Number.NEGATIVE_INFINITY;
  const swappedEnd = from ? parseDay(from, true) : Number.POSITIVE_INFINITY;
  if (swappedStart == null || swappedEnd == null) return null;
  return { start: swappedStart, end: swappedEnd };
}

/** The window of the same length immediately before this one. All time and custom have none. */
export function previousScanWindow(range: ScanRange, now: number): ScanWindow | null {
  const current = scanWindow(range, now);
  if (!current || range === 'all' || range === 'custom') return null;
  const span = current.end - current.start;
  return { start: current.start - span, end: current.start, endExclusive: true };
}

function rowMs(row: ActivityItem): number | null {
  const t = Date.parse(row.createdAt);
  return Number.isFinite(t) ? t : null;
}

export function rowsInWindow(rows: ActivityItem[], window: ScanWindow | null): ActivityItem[] {
  if (!window) return [];
  return rows.filter((row) => {
    const t = rowMs(row);
    if (t == null) return false;
    if (t < window.start) return false;
    return window.endExclusive ? t < window.end : t <= window.end;
  });
}

/** Pools only when the label itself says so. A send whose note mentions a pool stays a send. */
export function scanChipOf(row: ActivityItem): Exclude<ScanChip, 'all'> {
  if (/\b(pool|liquidity)\b/i.test(row.label) || /\blp\b/i.test(row.label)) return 'pool';
  const category = categoryOf(row);
  if (category === 'swap') return 'swap';
  if (category === 'nft') return 'nft';
  if (category === 'receive') return 'receive';
  if (category === 'send') return 'send';
  return 'other';
}

/** The small word on the row. A withdraw stays under Sends and keeps its own word. */
export function scanKind(row: ActivityItem): string {
  const chip = scanChipOf(row);
  if (chip === 'pool') return 'POOL';
  if (chip === 'swap') return 'SWAP';
  if (chip === 'nft') return 'NFT';
  if (chip === 'receive') return 'RECEIVE';
  if (row.type === 'withdraw') return 'WITHDRAW';
  if (chip === 'send') return 'SEND';
  if (row.type === 'claim') return 'CLAIM';
  return 'OTHER';
}

export function scanWho(value: string | null | undefined): string {
  if (!value) return '';
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? shortAddr(value) : value;
}

/** A Flizy username already checked by the feed. Anything else is not a name. */
export function scanActor(row: ActivityItem): string | null {
  const actor = typeof row.actor === 'string' ? row.actor.trim() : '';
  return /^@[a-z][a-z0-9]{2,23}$/.test(actor) ? actor : null;
}

/** How a payment travelled ("Flizy pay"), as the feed named it. */
function scanRail(row: ActivityItem): string | null {
  const rail = typeof row.rail === 'string' ? row.rail.trim() : '';
  return /^[A-Za-z]+ pay$|^Claim$/.test(rail) ? rail : null;
}

/** The sender leads the headline; a sender who hides their name is replaced by the rail. */
function actorPrefix(row: ActivityItem): string {
  const actor = scanActor(row);
  if (actor) return `${actor} · `;
  const rail = scanRail(row);
  return rail ? `${rail} · ` : '';
}

/** The rail as its own line under the headline, when the sender leads it. */
export function scanRailLine(row: ActivityItem): string | null {
  return scanActor(row) ? scanRail(row) : null;
}

export function scanHeadline(row: ActivityItem): string {
  const who = actorPrefix(row);
  const chip = scanChipOf(row);
  if (chip === 'nft' || chip === 'pool' || chip === 'other') return `${who}${row.label || scanKind(row)}`;
  if (chip === 'swap' && row.amountSecondary && row.assetSecondary) {
    return `${who}${formatAmount(row.amount)} ${row.asset} → ${formatAmount(row.amountSecondary)} ${row.assetSecondary}`;
  }
  const amount = `${formatAmount(row.amount)} ${row.asset}`;
  if (chip === 'swap') return `${who}${amount}`;
  const peer = scanWho(row.counterparty);
  if (row.direction === 'in') return `${who}${peer ? `${amount} from ${peer}` : amount}`;
  return `${who}${peer ? `${amount} → ${peer}` : amount}`;
}

export function scanSubline(row: ActivityItem): string {
  const chip = scanChipOf(row);
  if (chip === 'swap') return row.assetSecondary ? `${row.asset} → ${row.assetSecondary}` : row.asset;
  if (chip === 'nft' || chip === 'pool' || chip === 'other') return scanWho(row.counterparty) || row.asset;
  const who = scanWho(row.counterparty);
  if (row.direction === 'in') return who ? `${row.asset} ← ${who}` : row.asset;
  return who ? `${row.asset} → ${who}` : row.asset;
}

/** "Flizy app" is the site. A name that is only a chain label is not a channel. */
export function scanChannel(channel: string | null | undefined): string | null {
  if (!channel) return null;
  const name = channel.trim();
  if (!name || /x layer/i.test(name)) return null;
  return name.toLowerCase() === 'flizy app' ? 'Flizy' : name;
}

export function relativeWhen(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const sec = Math.round((now - t) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function explorerTxUrl(base: string | null | undefined, hash: string | null | undefined): string | null {
  if (!base || !hash) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  const root = base.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(root)) return null;
  return `${root}/tx/${hash}`;
}

/**
 * The ETH a settled row moved. A token-for-ETH swap moved the ETH it received,
 * so its other leg counts; a row with no ETH side at all cannot be priced.
 */
function settledAmount(row: ActivityItem): number | null {
  if (statusPill(row.status).tone === 'bad') return 0;
  const ethLeg =
    String(row.asset || '').toUpperCase() === 'ETH'
      ? row.amount
      : String(row.assetSecondary || '').toUpperCase() === 'ETH'
        ? row.amountSecondary
        : null;
  if (ethLeg == null) return null;
  if (typeof ethLeg === 'string' && ethLeg.trim() === '') return null;
  const n = Number(ethLeg);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n);
}

/** Dollar volume of settled ETH in the window, 0 when nothing settled, null when a row cannot be priced. */
export function volumeUsd(rows: ActivityItem[], usdPerEth: number | null): number | null {
  let eth = 0;
  let settled = 0;
  for (const row of rows) {
    const amount = settledAmount(row);
    if (amount == null) return null;
    if (statusPill(row.status).tone !== 'bad') settled += 1;
    eth += amount;
  }
  // A zero ETH total needs no rate. A missing rate must not invent a dollar figure.
  if (settled === 0 || eth === 0) return 0;
  if (usdPerEth == null || !Number.isFinite(usdPerEth) || usdPerEth <= 0) return null;
  return eth * usdPerEth;
}

function changePct(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || !(previous > 0)) return null;
  return ((current - previous) / previous) * 100;
}

export type ScanStats = {
  volumeUsd: number | null;
  volumePct: number | null;
  transactions: number;
  transactionsPct: number | null;
  swaps: number;
  swapsPct: number | null;
  nfts: number;
  nftsPct: number | null;
};

function countOf(rows: ActivityItem[], chip: 'swap' | 'nft'): number {
  return rows.filter((row) => scanChipOf(row) === chip).length;
}

export function scanStats(
  rows: ActivityItem[],
  range: ScanRange,
  now: number,
  usdPerEth: number | null,
  from = '',
  to = ''
): ScanStats {
  const current = rowsInWindow(rows, scanWindow(range, now, from, to));
  const previousWindow = range === 'custom' ? null : previousScanWindow(range, now);
  const previous = previousWindow ? rowsInWindow(rows, previousWindow) : null;
  const volume = volumeUsd(current, usdPerEth);
  const previousVolume = previous ? volumeUsd(previous, usdPerEth) : null;
  return {
    volumeUsd: volume,
    volumePct: changePct(volume, previousVolume),
    transactions: current.length,
    transactionsPct: changePct(current.length, previous ? previous.length : null),
    swaps: countOf(current, 'swap'),
    swapsPct: changePct(countOf(current, 'swap'), previous ? countOf(previous, 'swap') : null),
    nfts: countOf(current, 'nft'),
    nftsPct: changePct(countOf(current, 'nft'), previous ? countOf(previous, 'nft') : null),
  };
}

export function formatScanUsd(value: number | null): string {
  if (value == null) return '-';
  const body = `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return value === 0 ? body : `\u2248 ${body}`;
}

export function formatScanPct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded === 0) return '0%';
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

function haystack(row: ActivityItem): string {
  const pill = statusPill(row.status);
  return [
    row.label,
    row.amount,
    row.amountSecondary,
    row.asset,
    row.assetSecondary,
    row.counterparty,
    row.channel,
    scanChannel(row.channel),
    row.txHash,
    row.note,
    row.status,
    pill.label,
    scanKind(row),
    scanHeadline(row),
    scanSubline(row),
  ]
    .filter((part) => part != null && String(part).trim() !== '')
    .join(' ')
    .toLowerCase();
}

export type ScanListQuery = {
  range: ScanRange;
  now: number;
  from?: string;
  to?: string;
  chip: ScanChip;
  status: ScanStatus;
  query: string;
  sort: ScanSort;
};

export function filterScanRows(rows: ActivityItem[], query: ScanListQuery): ActivityItem[] {
  const window = scanWindow(query.range, query.now, query.from || '', query.to || '');
  const words = query.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = rowsInWindow(rows, window).filter((row) => {
    if (query.chip !== 'all' && scanChipOf(row) !== query.chip) return false;
    if (query.status !== 'all' && statusPill(row.status).tone !== query.status) return false;
    if (words.length === 0) return true;
    const text = haystack(row);
    return words.every((word) => text.includes(word));
  });
  return matched
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const at = rowMs(a.row);
      const bt = rowMs(b.row);
      if (at == null && bt == null) return a.index - b.index;
      if (at == null) return 1;
      if (bt == null) return -1;
      const delta = query.sort === 'oldest' ? at - bt : bt - at;
      return delta === 0 ? a.index - b.index : delta;
    })
    .map((entry) => entry.row);
}
