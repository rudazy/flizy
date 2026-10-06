'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDashboard } from './DashboardProvider';
import {
  ArrowDownIcon,
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  ExternalLinkIcon,
  FilterIcon,
  NftsIcon,
  SearchIcon,
  SwapArrowsIcon,
} from './ExploreIcons';
import type { ActivityItem } from '../lib/dashboardTypes';
import { activityRows, statusPill, type Tone } from '../lib/historyView';
import {
  SCAN_CHIPS,
  SCAN_RANGES,
  SCAN_SORTS,
  SCAN_STATUSES,
  explorerTxUrl,
  filterScanRows,
  formatScanPct,
  formatScanUsd,
  relativeWhen,
  scanChannel,
  scanChipOf,
  scanHeadline,
  scanKind,
  scanStats,
  scanWho,
  type ScanChip,
  type ScanRange,
  type ScanSort,
  type ScanStatus,
} from '../lib/walletScan';

const NO_SCROLL = '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden';

/** Shared by the column labels and each wide row, so the ledger stays aligned. */
const LEDGER_GRID =
  'lg:grid-cols-[40px_92px_minmax(0,1fr)_minmax(88px,150px)_92px_76px_116px_16px] lg:gap-x-3';

/**
 * Wallet Scan. The same activity History reads, arranged as a range, four
 * totals and a ledger. Dollars appear only when walletScan can price the
 * window. The instrument is drawn here. It is not a picture of sample trades.
 */
export function WalletScan() {
  const { activity, history, historyUsdPerEth, explorerBase } = useDashboard();
  const rows = activityRows(activity, history);
  const [range, setRange] = useState<ScanRange>('24h');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [datesOpen, setDatesOpen] = useState(false);
  const [chip, setChip] = useState<ScanChip>('all');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ScanStatus>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const [sort, setSort] = useState<ScanSort>('latest');
  const [sortOpen, setSortOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const datesRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setDatesOpen(false);
      setFilterOpen(false);
      setSortOpen(false);
      setOpenId(null);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!datesOpen && !filterOpen && !sortOpen) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (datesRef.current && !datesRef.current.contains(target)) setDatesOpen(false);
      if (filterRef.current && !filterRef.current.contains(target)) setFilterOpen(false);
      if (sortRef.current && !sortRef.current.contains(target)) setSortOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [datesOpen, filterOpen, sortOpen]);

  const now = Date.now();
  const stats = scanStats(rows, range, now, historyUsdPerEth, from, to);
  const visible = filterScanRows(rows, { range, now, from, to, chip, status, query, sort });
  const sortLabel = SCAN_SORTS.find((item) => item.id === sort)?.label || 'Latest first';

  function pickRange(id: Exclude<ScanRange, 'custom'>) {
    setRange(id);
    setFrom('');
    setTo('');
    setDatesOpen(false);
  }

  function pickDate(which: 'from' | 'to', value: string) {
    const nextFrom = which === 'from' ? value : from;
    const nextTo = which === 'to' ? value : to;
    setFrom(nextFrom);
    setTo(nextTo);
    setRange(nextFrom || nextTo ? 'custom' : '24h');
  }

  function closeOthers(keep: 'dates' | 'filter' | 'sort') {
    if (keep !== 'dates') setDatesOpen(false);
    if (keep !== 'filter') setFilterOpen(false);
    if (keep !== 'sort') setSortOpen(false);
  }

  return (
    <div className="scan-desk grid min-w-0 gap-4" aria-label="Scan">
      <section
        className="relative min-w-0 rounded-[16px] border border-[#4a3d1c]"
        style={{ background: 'linear-gradient(105deg, #0e0d0b 0%, #14120c 48%, #1c1709 100%)' }}
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[16px]" aria-hidden>
          <div
            className="absolute inset-y-0 right-0 w-[58%]"
            style={{
              backgroundImage:
                'linear-gradient(rgba(224,184,74,0.09) 1px, transparent 1px), linear-gradient(90deg, rgba(224,184,74,0.09) 1px, transparent 1px)',
              backgroundSize: '22px 22px',
              maskImage: 'radial-gradient(circle at 72% 46%, #000 0%, transparent 70%)',
              WebkitMaskImage: 'radial-gradient(circle at 72% 46%, #000 0%, transparent 70%)',
            }}
          />
          <div className="absolute -right-10 top-[-18%] h-56 w-56 rounded-full bg-[#e0b84a]/10 blur-3xl" />
        </div>

        <div className="relative flex min-w-0 items-center gap-3 px-4 py-5 md:grid md:grid-cols-[minmax(0,1fr)_240px] md:gap-6 md:px-7 md:py-7 lg:grid-cols-[minmax(0,34rem)_minmax(260px,1fr)] lg:gap-10 lg:py-8">
          <div className="min-w-0 max-w-xl flex-1">
            <p className="m-0 font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-sun">Activity</p>
            <h2 className="m-0 mt-2 bg-gradient-to-br from-[#fff6d8] via-[#f7d047] to-[#c4893f] bg-clip-text font-sans text-[36px] font-semibold leading-none tracking-[0.03em] text-transparent sm:text-[44px] lg:text-[52px]">
              Scan
            </h2>
            <p className="mb-0 mt-3 max-w-md font-sans text-[13px] leading-relaxed text-[#d4ccbf] sm:text-[14px]">
              Recent activity on Flizy, in one place.
              <br />
              Swaps, sends, receives, pools, NFTs and more.
            </p>
            <div className="mt-4 max-w-[9rem]">
              <div className="section-rule" />
            </div>
          </div>
          <ScanArt />
        </div>

        <div className="relative flex min-w-0 items-center gap-2 border-t border-[#3a3220] px-4 py-3 md:px-7">
          <div className={`flex min-w-0 flex-1 gap-1.5 overflow-x-auto ${NO_SCROLL}`} role="tablist" aria-label="Time range">
            {SCAN_RANGES.map((item) => {
              const active = range === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => pickRange(item.id)}
                  className={`hit-y-44 h-8 shrink-0 rounded-full px-3.5 font-sans text-[12.5px] ${
                    active
                      ? 'border border-sun bg-sun font-semibold text-sun-ink shadow-[0_0_18px_rgba(247,208,71,0.22)]'
                      : 'border border-[#3a3424] bg-[#14130f]/80 text-[#d6d0c6] hover:border-[#5a4a28] hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
          <div className="relative shrink-0" ref={datesRef}>
            <button
              type="button"
              aria-label="Choose dates"
              aria-expanded={datesOpen}
              onClick={() => {
                setDatesOpen((open) => !open);
                closeOthers('dates');
              }}
              className={`hit-44 flex h-8 w-8 items-center justify-center rounded-[8px] border ${
                range === 'custom' || datesOpen
                  ? 'border-sun bg-sun-wash text-sun'
                  : 'border-[#3a3424] bg-[#14130f]/80 text-[#d6d0c6] hover:text-white'
              }`}
            >
              <CalendarIcon size={15} />
            </button>
            {datesOpen ? (
              <div className="absolute right-0 z-30 mt-2 w-[min(220px,calc(100vw-2.5rem))] overflow-hidden rounded-[12px] border border-[#4a3d1c] bg-[#14130f] p-3 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sun/70 to-transparent" />
                <div className="grid min-w-0 gap-2">
                  <DateField label="From" value={from} onChange={(value) => pickDate('from', value)} />
                  <DateField label="To" value={to} onChange={(value) => pickDate('to', value)} />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <div
        className={`flex min-w-0 gap-2.5 overflow-x-auto sm:grid sm:grid-cols-4 sm:overflow-visible ${NO_SCROLL}`}
        role="list"
        aria-label="Totals for this range"
      >
        <StatCard icon={<BarsGlyph />} value={formatScanUsd(stats.volumeUsd)} label="Volume" pct={stats.volumePct} unavailable={stats.volumeUsd == null} />
        <StatCard icon={<RowsGlyph />} value={String(stats.transactions)} label="Transactions" pct={stats.transactionsPct} />
        <StatCard icon={<SwapArrowsIcon size={15} />} value={String(stats.swaps)} label="Swaps" pct={stats.swapsPct} />
        <StatCard icon={<NftsIcon size={15} />} value={String(stats.nfts)} label="NFTs" pct={stats.nftsPct} />
      </div>

      <section className="min-w-0 rounded-[16px] border border-[#2c2820] bg-[#0e0d0b]">
        <div className="flex min-w-0 items-center gap-2 px-3 pt-3 sm:px-4">
          <label className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-[12px] border border-[#2c2820] bg-[#100e0b] px-3.5 transition-colors focus-within:border-[#c4893f]">
            <SearchIcon size={16} className="shrink-0 text-[#9a9388]" />
            <span className="sr-only">Search activity</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search transactions, tokens, addresses..."
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-sans text-base text-white outline-none placeholder:text-[#8a847c]"
            />
          </label>
          <div className="relative shrink-0" ref={filterRef}>
            <button
              type="button"
              aria-expanded={filterOpen}
              onClick={() => {
                setFilterOpen((open) => !open);
                closeOthers('filter');
              }}
              className={`hit-y-44 inline-flex h-12 items-center gap-1.5 rounded-[12px] border px-3.5 font-sans text-[13px] ${
                status !== 'all' || filterOpen
                  ? 'border-sun bg-sun-wash text-sun'
                  : 'border-[#3a3424] text-[#d6d0c6] hover:text-white'
              }`}
            >
              <FilterIcon size={14} />
              Filter
            </button>
            {filterOpen ? (
              <div className="absolute right-0 z-30 mt-2 w-[180px] overflow-hidden rounded-[12px] border border-[#4a3d1c] bg-[#14130f] p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]" role="listbox" aria-label="Status">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sun/70 to-transparent" />
                {SCAN_STATUSES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={status === item.id}
                    onClick={() => {
                      setStatus(item.id);
                      setFilterOpen(false);
                    }}
                    className={`block w-full rounded-[8px] px-2.5 py-2 text-left font-sans text-[13px] ${
                      status === item.id ? 'bg-sun-wash text-sun' : 'text-[#d6d0c6] hover:bg-[#1c1a14] hover:text-white'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className={`mt-3 flex min-w-0 gap-1.5 overflow-x-auto px-3 pb-3 sm:px-4 ${NO_SCROLL}`} role="tablist" aria-label="Activity type">
          {SCAN_CHIPS.map((item) => {
            const active = chip === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setChip(item.id)}
                className={`hit-y-44 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 font-sans text-[12.5px] ${
                  active
                    ? 'border-sun bg-sun-wash font-semibold text-sun'
                    : 'border-[#3a3424] text-[#d6d0c6] hover:border-[#5a4a28] hover:text-white'
                }`}
              >
                <ChipMark id={item.id} />
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#2c2820] px-4 py-3">
          <h3 className="m-0 font-sans text-[15px] font-semibold tracking-[0.04em] text-white sm:text-[16px]">Recent Activity</h3>
          <div className="relative" ref={sortRef}>
            <button
              type="button"
              aria-expanded={sortOpen}
              onClick={() => {
                setSortOpen((open) => !open);
                closeOthers('sort');
              }}
              className="hit-y-44 inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-[#3a3424] bg-[#14130f] px-2.5 font-sans text-[12.5px] text-[#d6d0c6] hover:text-white"
            >
              <ArrowDownIcon size={13} className={sort === 'oldest' ? 'rotate-180' : ''} />
              {sortLabel}
              <ChevronDownIcon size={13} />
            </button>
            {sortOpen ? (
              <div className="absolute right-0 z-30 mt-2 w-[160px] overflow-hidden rounded-[12px] border border-[#4a3d1c] bg-[#14130f] p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-sun/70 to-transparent" />
                {SCAN_SORTS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSort(item.id);
                      setSortOpen(false);
                    }}
                    className={`block w-full rounded-[8px] px-2.5 py-2 text-left font-sans text-[13px] ${
                      sort === item.id ? 'bg-sun-wash text-sun' : 'text-[#d6d0c6] hover:bg-[#1c1a14] hover:text-white'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {visible.length > 0 ? (
          <div
            className={`hidden border-t border-[#2c2820] px-4 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-[#8f887c] lg:grid ${LEDGER_GRID}`}
            aria-hidden
          >
            <span />
            <span>Type</span>
            <span>Detail</span>
            <span>Asset</span>
            <span>Channel</span>
            <span>When</span>
            <span>Status</span>
            <span />
          </div>
        ) : null}

        {visible.length === 0 ? (
          <div className="border-t border-[#2c2820] px-4 py-14">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[#4a3d1c] bg-[#1b190e] text-sun" aria-hidden>
              <SearchIcon size={16} />
            </div>
            <p className="m-0 mt-3 text-center font-sans text-[13px] text-[#c8c0b2]">
              {query.trim() ? 'Nothing matches that search.' : 'Nothing in this range.'}
            </p>
          </div>
        ) : (
          <div className="border-t border-[#2c2820]">
            {visible.map((row) => (
              <ScanRow
                key={row.id}
                row={row}
                now={now}
                explorerBase={explorerBase}
                open={openId === row.id}
                onToggle={() => setOpenId((current) => (current === row.id ? null : row.id))}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon,
  value,
  label,
  pct,
  unavailable = false,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  pct: number | null;
  unavailable?: boolean;
}) {
  const printed = formatScanPct(pct);
  const up = pct != null && Math.round(pct) > 0;
  const down = pct != null && Math.round(pct) < 0;
  const tone = up ? 'text-[#2fd27a]' : down ? 'text-[#f05252]' : 'text-[#9a9388]';
  const wash = up ? 'bg-[#10261a]' : down ? 'bg-[#2a1414]' : '';
  return (
    <article
      className="relative flex w-[148px] shrink-0 flex-col rounded-[14px] border border-[#2c2820] bg-[#10100e] px-3.5 py-3.5 sm:w-auto sm:min-w-0"
      role="listitem"
    >
      <span className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-[#e0b84a]/80 to-transparent" aria-hidden />
      <span className="flex items-start justify-between gap-2">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.16em] text-[#b7b0a4]">{label}</span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-[#1b190e] text-sun" aria-hidden>
          {icon}
        </span>
      </span>
      <span
        className="mt-3 block truncate font-sans text-[22px] font-semibold leading-none tracking-tight text-white lg:text-[28px]"
        title={value}
        aria-label={unavailable ? `${label} unavailable` : undefined}
      >
        {value}
      </span>
      <span className={`mt-2 inline-flex min-h-[18px] w-fit items-center rounded-full font-sans text-[11px] ${tone} ${printed ? `px-1.5 py-px ${wash}` : ''}`}>
        {printed || ''}
      </span>
    </article>
  );
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid min-w-0 gap-1 font-sans text-[11px] text-[#9a9388]">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="box-border h-10 w-full min-w-0 max-w-full rounded-[8px] border border-[#3a3424] bg-ink px-2 font-sans text-base text-paper accent-lime [color-scheme:dark]"
      />
    </label>
  );
}

function ScanRow({
  row,
  now,
  explorerBase,
  open,
  onToggle,
}: {
  row: ActivityItem;
  now: number;
  explorerBase: string;
  open: boolean;
  onToggle: () => void;
}) {
  const kind = scanKind(row);
  const pill = statusPill(row.status);
  const channel = scanChannel(row.channel);
  const headline = scanHeadline(row);
  const when = relativeWhen(row.createdAt, now);
  const url = explorerTxUrl(explorerBase, row.txHash);
  const detailsId = `scan-${row.id}`;

  return (
    <article className={`border-b border-[#241f18] last:border-b-0 ${open ? 'bg-[#16140f] shadow-[inset_3px_0_0_#e0b84a]' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={detailsId}
        className="w-full p-0 text-left hover:bg-[#16140f]"
      >
        <span className="flex w-full items-center gap-3 px-3 py-3.5 sm:px-4 lg:hidden">
          <KindIcon row={row} />
          <span className="grid min-w-0 flex-1 gap-1">
            <span className="flex items-center justify-between gap-2">
              <KindLabel kind={kind} />
              <span className="shrink-0 font-mono text-[11px] text-[#8f887c]">{when}</span>
            </span>
            <span className="truncate font-sans text-[14px] font-medium text-white" title={headline}>
              {headline}
            </span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-sans text-[12px] text-[#c8c0b2]">
                <AssetBits row={row} />
              </span>
              {channel ? <ChannelPill channel={channel} /> : null}
              <StatusText tone={pill.tone} label={pill.label} />
            </span>
          </span>
          <ChevronRightIcon size={15} className={`shrink-0 text-[#8f887c] transition-transform ${open ? 'rotate-90 text-sun' : ''}`} />
        </span>

        <span className={`hidden w-full items-center px-4 py-3.5 lg:grid ${LEDGER_GRID}`}>
          <KindIcon row={row} />
          <KindLabel kind={kind} />
          <span className="min-w-0 truncate font-sans text-[14px] font-medium text-white" title={headline}>
            {headline}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 font-sans text-[12px] text-[#c8c0b2]">
            <AssetBits row={row} />
          </span>
          <span className="min-w-0">{channel ? <ChannelPill channel={channel} /> : null}</span>
          <span className="font-mono text-[12px] text-[#b7b0a4]">{when}</span>
          <StatusText tone={pill.tone} label={pill.label} />
          <ChevronRightIcon size={15} className={`text-[#8f887c] transition-transform ${open ? 'rotate-90 text-sun' : ''}`} />
        </span>
      </button>
      {open ? (
        <div id={detailsId} className="grid gap-2 border-t border-[#2c2820] px-4 py-3 lg:pl-[4.75rem]">
          <p className="m-0 break-words font-sans text-[13px] leading-relaxed text-[#f3efe6]">{row.label}</p>
          {row.note ? <p className="m-0 break-words font-sans text-[12px] leading-relaxed text-[#9a9388]">{row.note}</p> : null}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-11 w-fit items-center gap-1.5 rounded-[6px] border border-[#4a3d1c] bg-[#1b190e] px-3 font-sans text-[12px] text-sun no-underline hover:border-sun"
            >
              View on explorer <ExternalLinkIcon size={12} />
            </a>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function KindIcon({ row }: { row: ActivityItem }) {
  return (
    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] ${iconClass(row)}`} aria-hidden>
      <RowIcon row={row} />
    </span>
  );
}

function KindLabel({ kind }: { kind: string }) {
  return <span className={`truncate font-sans text-[11px] font-semibold tracking-[0.08em] ${kindClass(kind)}`}>{kind}</span>;
}

function ChannelPill({ channel }: { channel: string }) {
  return (
    <span className="inline-flex max-w-full truncate rounded-full border border-[#3a3424] px-2 py-px font-sans text-[11px] text-[#e4dccf]">
      {channel}
    </span>
  );
}

function StatusText({ tone, label }: { tone: Tone; label: string }) {
  const color =
    tone === 'good' ? 'text-[#2fd27a]' : tone === 'pending' ? 'text-sun' : tone === 'bad' ? 'text-[#f05252]' : 'text-[#c8c0b2]';
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 font-sans text-[12px] ${color}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  );
}

function AssetBits({ row }: { row: ActivityItem }) {
  const chip = scanChipOf(row);
  if (chip === 'swap' && row.assetSecondary) {
    return (
      <>
        <Ticker symbol={row.asset} />
        <span aria-hidden className="text-[#8f887c]">→</span>
        <Ticker symbol={row.assetSecondary} />
      </>
    );
  }
  if (chip === 'nft' || chip === 'pool' || chip === 'other') {
    const who = scanWho(row.counterparty);
    const headline = scanHeadline(row);
    if (who && who !== row.label && who !== headline) return <span className="truncate">{who}</span>;
    return <Ticker symbol={row.asset} />;
  }
  const who = scanWho(row.counterparty);
  const inbound = row.direction === 'in';
  return (
    <>
      <Ticker symbol={row.asset} tone={inbound ? 'green' : 'gold'} />
      {who ? (
        <>
          <span aria-hidden className="text-[#8f887c]">{inbound ? '←' : '→'}</span>
          <span className="truncate">{who}</span>
        </>
      ) : null}
    </>
  );
}

function Ticker({ symbol, tone = 'gold' }: { symbol: string; tone?: 'gold' | 'green' }) {
  const name = (symbol || '').trim();
  if (!name) return null;
  const color = tone === 'green'
    ? 'border-[#1e4630] bg-[#10261a] text-[#2fd27a]'
    : 'border-[#4a3d1c] bg-[#1b190e] text-[#f0d48a]';
  return (
    <span className={`inline-flex max-w-[4.75rem] shrink-0 truncate rounded-[4px] border px-1.5 py-px font-sans text-[11px] font-medium tracking-wide ${color}`}>
      {name}
    </span>
  );
}

function iconClass(row: ActivityItem): string {
  if (statusPill(row.status).tone === 'bad') return 'bg-[#2a1414] text-[#f05252]';
  if (row.direction === 'in') return 'bg-[#10261a] text-[#2fd27a]';
  const chip = scanChipOf(row);
  if (chip === 'swap' || chip === 'other') return 'bg-[#2a2310] text-sun';
  if (chip === 'nft' || chip === 'pool') return 'bg-[#221d14] text-[#e6c88a]';
  return 'bg-[#1b1c20] text-[#ececec]';
}

function kindClass(kind: string): string {
  if (kind === 'RECEIVE') return 'text-[#2fd27a]';
  if (kind === 'SWAP' || kind === 'CLAIM') return 'text-sun';
  if (kind === 'NFT' || kind === 'POOL') return 'text-[#e6c88a]';
  return 'text-[#ececec]';
}

function RowIcon({ row }: { row: ActivityItem }) {
  const chip = scanChipOf(row);
  if (chip === 'swap') return <SwapArrowsIcon size={18} />;
  if (chip === 'nft') return <NftsIcon size={18} />;
  if (chip === 'pool') return <PoolGlyph />;
  if (chip === 'other') return <ClockIcon size={18} />;
  if (row.direction === 'in') return <ArrowDownIcon size={18} />;
  if (row.type === 'withdraw') return <ArrowDownIcon size={18} className="rotate-180" />;
  return <PlaneGlyph />;
}

function ChipMark({ id }: { id: ScanChip }) {
  if (id === 'all') return null;
  const className = 'text-current';
  if (id === 'swap') return <SwapArrowsIcon size={12} className={className} />;
  if (id === 'send') return <PlaneGlyph className={className} />;
  if (id === 'receive') return <ArrowDownIcon size={12} className={className} />;
  if (id === 'pool') return <PoolGlyph />;
  if (id === 'nft') return <NftsIcon size={12} className={className} />;
  return <ClockIcon size={12} className={className} />;
}

function ScanArt() {
  return (
    <div className="relative h-[104px] w-[116px] shrink-0 md:h-[156px] md:w-full lg:h-[188px]" aria-hidden>
      <div className="absolute inset-[8%] rounded-[50%] border border-[#e0b84a]/20" />
      <div className="absolute inset-[18%] rounded-[50%] border border-[#e0b84a]/35" />
      <div className="absolute inset-[5%] rounded-[50%] border border-dashed border-[#e0b84a]/40" />
      <div className="absolute left-1/2 top-1/2 aspect-square h-[76%] -translate-x-1/2 -translate-y-1/2">
        <div
          className="scan-orbit h-full w-full rounded-full"
          style={{
            background:
              'conic-gradient(from 0deg, transparent 0%, transparent 68%, rgba(224,184,74,0) 74%, rgba(224,184,74,0.42) 100%)',
            maskImage: 'radial-gradient(circle, transparent 54%, #000 60%, #000 74%, transparent 78%)',
            WebkitMaskImage: 'radial-gradient(circle, transparent 54%, #000 60%, #000 74%, transparent 78%)',
          }}
        />
      </div>
      <ArtTile className="left-0 top-1 md:left-[6%] md:top-[14%]">
        <SwapArrowsIcon size={14} />
      </ArtTile>
      <ArtTile className="right-0 top-0 md:right-[8%] md:top-[10%]">
        <PlaneGlyph />
      </ArtTile>
      <ArtTile className="bottom-1 left-1 md:bottom-[12%] md:left-[12%]">
        <PoolGlyph />
      </ArtTile>
      <ArtTile className="bottom-0 right-1 md:bottom-[8%] md:right-[10%]">
        <NftsIcon size={14} />
      </ArtTile>
      <div className="absolute left-1/2 top-1/2 h-[64px] w-[64px] -translate-x-1/2 -translate-y-[54%] md:h-[78px] md:w-[78px]">
        <div className="flex h-[52px] w-[52px] items-center justify-center rounded-full border-2 border-sun bg-[#141208] shadow-[0_0_28px_rgba(224,184,74,0.42)] md:h-[64px] md:w-[64px] md:border-[2.5px]">
          <span className="font-sans text-[22px] font-semibold leading-none text-sun md:text-[28px]">F</span>
        </div>
        <span className="absolute bottom-0 right-1 h-[14px] w-[3px] origin-top rotate-45 rounded-full bg-sun md:h-[18px]" />
      </div>
    </div>
  );
}

function ArtTile({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span
      className={`absolute flex h-8 w-8 items-center justify-center rounded-[8px] border border-[#5a4a28] bg-[#16140c]/95 text-sun shadow-[0_8px_18px_rgba(0,0,0,0.35)] md:h-9 md:w-9 ${className}`}
    >
      {children}
    </span>
  );
}

function PlaneGlyph({ className }: { className?: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M4.2 11.2L20 4.2l-6.2 15.6-2.3-6.2L4.2 11.2z" />
      <path d="M11.4 13.5L20 4.2" />
    </svg>
  );
}

function PoolGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <ellipse cx="12" cy="7" rx="6.2" ry="2.3" />
      <path d="M5.8 7v5c0 1.25 2.8 2.3 6.2 2.3s6.2-1.05 6.2-2.3V7" />
      <path d="M5.8 12v5c0 1.25 2.8 2.3 6.2 2.3s6.2-1.05 6.2-2.3v-5" />
    </svg>
  );
}

function BarsGlyph() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M5 19V11M10 19V7M15 19V13M20 19V5" />
    </svg>
  );
}

function RowsGlyph() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M5 7h14M5 12h14M5 17h10" />
    </svg>
  );
}
