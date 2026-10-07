'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  TOKEN_FILTERS,
  TOKEN_VIEWS,
  filterHelper,
  isTokenFilter,
  tokensForFilter,
  type DiscoveryToken,
  type TokenFilterId,
} from '../lib/tokenDiscovery';
import { formatEthDisplay } from '../lib/tokenFormat';
import { useComingSoon } from './ComingSoon';
import { CopyTradePanel } from './CopyTradePanel';
import { VerifiedMark } from './VerifiedMark';
import {
  ArrowRightIcon,
  ChevronDownIcon,
  EthDiamondIcon,
  FlameIcon,
  GiwaMarkIcon,
  SearchIcon,
} from './ExploreIcons';

/**
 * Tokens: the GIWA market, the filtered lists, and copy trade.
 *
 * Discover is the landing: what trades on GIWA today and how to trade it. The
 * filters rank the listed tokens. Every figure is the pool's own, in ETH:
 * there is no dollar price on GIWA Sepolia, so none is shown.
 */

type TabId = 'discover' | 'copy' | TokenFilterId;

const [DISCOVER, COPY] = TOKEN_VIEWS;
const TABS: Array<{ id: TabId; label: string }> = [DISCOVER, COPY, ...TOKEN_FILTERS];

const HERO_SLIDES = 2;

/** Arrows kept out of the source as literals; see the ASCII rule for this repo. */
const UP = String.fromCharCode(0x25b2);
const DOWN = String.fromCharCode(0x25bc);

/** A number and its unit. ETH is drawn as the diamond, where a dollar sign would go. */
type Figure = { value: string; unit: 'ETH' | 'FLZ' | null };

/** One row on the list: a listed token, or ETH, which is the pool's other side. */
type Row = {
  symbol: string;
  name: string;
  verified: boolean;
  /** The price and the unit it is counted in. */
  price: Figure;
  change: number | null;
  spark: number[];
  /** Two figures for the middle of the row. */
  stats: Array<Figure & { label: string }>;
  href: string | null;
  /** The swap screen with this token as the one being bought. */
  trade: string;
};

function eth(raw: string | null | undefined): Figure {
  // From 1 up, two decimals, and one from 100 up, where more digits are noise;
  // small prices keep theirs.
  const n = Number(raw);
  const v =
    Number.isFinite(n) && n >= 1
      ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 1 : 2 })
      : formatEthDisplay(raw ?? null);
  return v ? { value: v, unit: 'ETH' } : { value: '-', unit: null };
}

function flzRow(t: DiscoveryToken): Row {
  return {
    symbol: t.symbol,
    name: t.symbol === 'FLZ' ? 'Flizy' : t.name,
    verified: t.verified,
    price: eth(t.priceEth),
    change: t.change1hPct,
    spark: t.spark || [],
    stats: [
      { ...eth(t.marketCapEth), label: 'Market cap' },
      { ...eth(t.liquidityEth), label: 'Liquidity' },
    ],
    href: `/dashboard/explore/tokens/${t.symbol.toLowerCase()}`,
    trade: '/dashboard/swap?from=ETH&to=FLZ',
  };
}

/**
 * ETH priced against FLZ from the same pool: its move is the inverse of FLZ's,
 * and its sparkline is the same candles turned over.
 */
function ethRow(flz: DiscoveryToken): Row {
  const per = Number(flz.flzPerEth);
  const change =
    flz.change1hPct != null && Number.isFinite(flz.change1hPct) && flz.change1hPct > -100
      ? (100 / (1 + flz.change1hPct / 100) - 100)
      : null;
  return {
    symbol: 'ETH',
    name: 'Ethereum',
    verified: true,
    price:
      Number.isFinite(per) && per > 0
        ? { value: per.toLocaleString('en-US', { maximumFractionDigits: 2 }), unit: 'FLZ' }
        : { value: '-', unit: null },
    change,
    spark: (flz.spark || []).filter((v) => v > 0).map((v) => 1 / v),
    stats: [
      // The pool prices ETH in FLZ. It does not give ETH a market cap.
      { value: '-', unit: null, label: 'Market cap' },
      { ...eth(flz.liquidityEth), label: 'In the pool' },
    ],
    href: null,
    trade: '/dashboard/swap?from=FLZ&to=ETH',
  };
}

export function ExploreTokens() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || '';
  const [comingSoon, comingSoonNote] = useComingSoon();
  const view = search.get('view');
  const requested = search.get('f') || '';
  const tab: TabId = view === 'copy' ? 'copy' : isTokenFilter(requested) ? requested : 'discover';
  const [tokens, setTokens] = useState<DiscoveryToken[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    if (tab === 'copy') return;
    let cancelled = false;
    (async () => {
      setError('');
      try {
        const res = await fetch('/api/tokens');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error || 'Could not load tokens.');
        else setTokens(Array.isArray(body.tokens) ? body.tokens : []);
      } catch {
        if (!cancelled) setError('Could not load tokens.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  function setTab(next: TabId) {
    const params = new URLSearchParams(search.toString());
    params.set('s', 'tokens');
    params.delete('view');
    params.delete('f');
    if (next === 'copy') params.set('view', 'copy');
    else if (next !== 'discover') params.set('f', next);
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  const rows = useMemo(() => {
    if (tab === 'copy') return [];
    const list = tokens || [];
    const base = tab === 'discover' ? list.filter((t) => t.priceEth != null) : tokensForFilter(tab, list).tokens;
    const out = base.map(flzRow);
    const flz = list.find((t) => t.symbol === 'FLZ');
    if (tab === 'discover' && flz && flz.flzPerEth) out.push(ethRow(flz));
    const q = query.trim().toLowerCase();
    return q ? out.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) : out;
  }, [tokens, tab, query]);

  const filterEmpty = tab !== 'discover' && tab !== 'copy' ? tokensForFilter(tab, []).empty : '';

  return (
    <div className="!mt-[9px] grid w-full grid-cols-[minmax(0,1fr)] gap-[12px]">
      <div
        className="-mx-4 flex overflow-x-auto border-b border-[#2a2b30] px-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Token section"
      >
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.id)}
              className={`hit-y-44 relative -mb-px h-[27px] shrink-0 whitespace-nowrap px-[10px] pb-[4px] font-sans text-[10px] ${
                active ? 'font-semibold text-sun' : 'text-[#bdbdbd] hover:text-white'
              }`}
            >
              {item.label}
              {active ? <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-sun" aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      {tab === 'copy' ? <CopyTradePanel /> : null}

      {tab === 'discover' ? <Hero slide={slide} setSlide={setSlide} /> : null}

      {tab !== 'copy' ? (
        <>
          <div className="flex gap-[9px]">
            <label className="flex h-[36px] min-w-0 flex-1 items-center gap-[11px] rounded-[5px] border border-[#2a2b30] bg-[#0d0d0e] px-[11px] focus-within:border-sun/60">
              <SearchIcon size={15} className="shrink-0 text-[#d6d6d6]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tokens (FLZ, ETH)..."
                aria-label="Search tokens"
                className="min-w-0 flex-1 bg-transparent font-sans text-[10.5px] text-white outline-none placeholder:text-[#8a8a8f]"
              />
            </label>
            <button
              type="button"
              onClick={() => comingSoon('Other chains')}
              aria-label="Chain: GIWA. Other chains coming soon"
              className="flex h-[36px] w-[96px] shrink-0 items-center gap-[9px] rounded-[5px] border border-[#2a2b30] bg-[#0d0d0e] pl-[11px] pr-[10px] font-sans text-[10.5px] text-white"
            >
              <GiwaMarkIcon size={16} />
              <span className="flex-1 text-left">GIWA</span>
              <ChevronDownIcon size={11} className="text-[#d9d9d9]" />
            </button>
          </div>

          <div className="mt-[8px] flex items-end justify-between gap-[10px]">
            <div className="min-w-0">
              <h2 className="m-0 flex items-center gap-[8px] font-sans text-[15px] font-bold text-white">
                <FlameIcon size={18} />
                {tab === 'discover' ? 'Tokens on GIWA' : TABS.find((t) => t.id === tab)?.label}
              </h2>
              <p className="m-0 mt-[4px] font-sans text-[10.4px] text-[#a9a9a9]">
                {tab === 'discover' ? 'Trade the available tokens on the GIWA chain.' : filterHelper(tab)}
              </p>
            </div>
            {tab === 'discover' ? (
              <button
                type="button"
                onClick={() => setTab('trending')}
                className="hit-y-44 flex h-[26px] shrink-0 items-center gap-[9px] rounded-[5px] border border-[#3a3b40] bg-[#0f0f10] px-[10px] font-sans text-[9.6px] text-[#ececec] hover:text-white"
              >
                View All
                <ArrowRightIcon size={11} strokeWidth={1.8} />
              </button>
            ) : null}
          </div>

          {error ? <p className="alert alert-error m-0">{error}</p> : null}
          {tokens === null && !error ? <p className="m-0 font-sans text-[10px] text-[#a9a9a9]">Loading...</p> : null}
          {tokens !== null && rows.length === 0 && !error ? (
            <p className="m-0 rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[14px] py-[14px] font-sans text-[10px] text-[#a9a9a9]">
              {query.trim() ? 'No listed token matches that search.' : filterEmpty || 'No listed token has a pool yet.'}
            </p>
          ) : null}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-[5px]">
            {rows.map((row, i) => (
              <TokenRow key={row.symbol} rank={i + 1} row={row} />
            ))}
          </div>

          {tab === 'discover' ? <GiwaCard /> : null}
        </>
      ) : null}
      {comingSoonNote}
    </div>
  );
}

function Hero({ slide, setSlide }: { slide: number; setSlide: (n: number) => void }) {
  const first = slide === 0;
  return (
    <section
      className="relative h-[214px] overflow-hidden rounded-[6px] border border-[#3a3017]"
      style={{ background: 'linear-gradient(120deg, #15120a 0%, #0e0d0a 60%, #0c0b09 100%)' }}
    >
      <div className="absolute inset-y-0 right-0 w-[167px]">
        <Image src="/explore/tokens-hero.png" alt="" fill sizes="167px" className="object-cover" priority />
        <span
          className="absolute inset-y-0 left-0 w-[40px]"
          style={{ background: 'linear-gradient(90deg, #120f09 0%, rgba(18,15,9,0) 100%)' }}
          aria-hidden
        />
      </div>
      <div className="relative flex h-full flex-col pl-[15px] pr-[12px] pt-[16px]">
        <span className="flex h-[21px] w-fit items-center gap-[7px] rounded-full border border-[#5a4a1c] bg-[#14110a] px-[9px] font-mono text-[8.2px] uppercase tracking-[0.12em] text-white">
          <GiwaMarkIcon size={12} />
          Giwa chain
        </span>
        <h2 className="m-0 mt-[12px] max-w-[210px] font-sans text-[21.5px] font-bold leading-[24.5px] text-white">
          {first ? (
            <>
              Trade on GIWA <br />
              with <span className="text-sun">zero hassle</span>
            </>
          ) : (
            <>
              Track FLZ <br />
              <span className="text-sun">live</span> on GIWA
            </>
          )}
        </h2>
        <p className="m-0 mt-[8px] max-w-[190px] font-sans text-[11px] leading-[15px] text-[#cfcfcf]">
          {first
            ? 'FLZ and ETH are now live on Flizy. Swap instantly and easily through your Flizy wallet.'
            : 'See the pool price, the chart and every trade, read straight from the chain.'}
        </p>
        <Link
          href={first ? '/dashboard/swap' : '/dashboard/explore/tokens/flz'}
          className="btn-sun mt-auto mb-[25px] h-[32px] w-fit gap-[9px] rounded-[5px] px-[13px] font-sans text-[11px] font-bold no-underline"
        >
          {first ? 'Swap Tokens' : 'Open FLZ'}
          <ArrowRightIcon size={13} strokeWidth={2.2} />
        </Link>
      </div>
      <div className="absolute bottom-[9px] left-1/2 flex -translate-x-1/2 gap-[5px]">
        {Array.from({ length: HERO_SLIDES }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSlide(i)}
            aria-label={`Slide ${i + 1}`}
            aria-current={slide === i}
            className={`h-[6px] rounded-full ${slide === i ? 'w-[8px] bg-sun' : 'w-[6px] bg-[#5c5c60]'}`}
          />
        ))}
      </div>
    </section>
  );
}

function TokenLogo({ symbol }: { symbol: string }) {
  if (symbol === 'ETH') {
    return (
      <span className="flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-full bg-[#627eea] text-white">
        <EthDiamondIcon size={14} />
      </span>
    );
  }
  return (
    <span className="flex h-[25px] w-[25px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-sun bg-[#0a0a0a] font-sans text-[13px] font-bold text-sun">
      {symbol.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * One token on one line: who it is, two pool figures, the last hour as a line,
 * the price, and Trade, which opens the swap with this token selected.
 */
function TokenRow({ rank, row }: { rank: number; row: Row }) {
  const up = row.change != null && row.change >= 0;
  const head = (
    <>
      <span className="w-[8px] shrink-0 text-center font-sans text-[9.5px] font-semibold text-white">{rank}</span>
      <TokenLogo symbol={row.symbol} />
      <span className="w-[46px] min-w-0 shrink-0">
        <span className="flex items-center gap-[3px] font-sans text-[9.6px] font-semibold text-white">
          {row.symbol}
          {row.verified ? (
            <span className="inline-flex scale-[0.72]">
              <VerifiedMark />
            </span>
          ) : null}
        </span>
        <span className="block truncate font-sans text-[7.6px] text-[#a9a9a9]">{row.name}</span>
      </span>
      {row.stats.map((s, i) => (
        <span key={s.label} className={`w-[44px] min-w-0 shrink-0 ${i ? '' : 'box-content border-l border-[#2a2b30] pl-[6px]'}`}>
          <span className="block truncate font-sans text-[8.6px] font-semibold text-white">
            <FigureText figure={s} />
          </span>
          <span className="block truncate font-sans text-[7px] text-[#a9a9a9]">{s.label}</span>
        </span>
      ))}
      <Sparkline points={row.spark} up={up} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[8.6px] font-semibold text-white">
          <FigureText figure={row.price} />
        </span>
        <span className={`block truncate font-sans text-[8px] ${row.change == null ? 'text-[#a9a9a9]' : up ? 'text-[#2fd27a]' : 'text-[#f05252]'}`}>
          {row.change == null ? 'No trades' : `${up ? UP : DOWN} ${Math.abs(row.change).toFixed(1)}%`}
        </span>
      </span>
    </>
  );
  return (
    <article className="flex h-[38.5px] min-w-0 items-center gap-[6px] rounded-[6px] border border-[#23242a] bg-[#0d0d0e] pl-[7px] pr-[5px]">
      {row.href ? (
        <Link href={row.href} className="flex min-w-0 flex-1 items-center gap-[6px] no-underline">
          {head}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-[6px]">{head}</span>
      )}
      <Link
        href={row.trade}
        aria-label={`Trade ${row.symbol}`}
        className="btn-sun hit-y-44 h-[22px] w-[40px] shrink-0 rounded-[4px] font-sans text-[9px] font-semibold no-underline"
      >
        Trade
      </Link>
    </article>
  );
}

function FigureText({ figure }: { figure: Figure }) {
  if (figure.unit === 'ETH') {
    return (
      <span className="inline-flex items-center gap-[2px]">
        <EthDiamondIcon size={8} className="shrink-0 text-[#8c8fe8]" />
        <span className="sr-only">ETH </span>
        {figure.value}
      </span>
    );
  }
  return <>{figure.unit ? `${figure.value} ${figure.unit}` : figure.value}</>;
}

/** The recent closes as a line. Nothing to draw with fewer than two points. */
function Sparkline({ points, up }: { points: number[]; up: boolean }) {
  const w = 36;
  const h = 18;
  // No trades in the window: a flat grey line, so the row keeps its shape.
  if (points.length < 2) {
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
        <path d={`M0 ${h / 2} L${w} ${h / 2}`} stroke="#5c5c60" strokeWidth="1.2" strokeDasharray="2 2" />
      </svg>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 2 - ((p - min) / span) * (h - 4)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const color = up ? '#2fd27a' : '#f05252';
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={color} fillOpacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function GiwaCard(): ReactNode {
  return (
    <section className="mt-[4px] rounded-[6px] border border-[#23242a] bg-[#0d0d0e] px-[22px] py-[14px]">
      <div className="flex items-center gap-[12px]">
        <span className="flex items-center gap-[8px] font-sans text-[14px] font-bold tracking-[0.04em] text-white">
          <GiwaMarkIcon size={20} />
          GIWA
        </span>
        <span className="h-[16px] w-px bg-[#3a3b40]" aria-hidden />
        <span className="font-sans text-[10px] text-[#cfcfcf]">
          Backed by <span className="font-semibold text-white">Upbit</span>
        </span>
      </div>
      <p className="m-0 mt-[8px] font-sans text-[10px] leading-[14px] text-[#cfcfcf]">
        GIWA is a next-generation chain backed by Korea&apos;s largest exchange, Upbit.
      </p>
      <a
        href="https://giwa.io"
        target="_blank"
        rel="noreferrer noopener"
        className="mt-[6px] inline-flex items-center gap-[8px] font-sans text-[10px] text-sun no-underline"
      >
        Learn more about GIWA
        <ArrowRightIcon size={11} strokeWidth={1.8} />
      </a>
    </section>
  );
}
