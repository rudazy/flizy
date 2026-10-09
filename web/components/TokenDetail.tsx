'use client';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppPage } from './AppSection';
import { useComingSoon } from './ComingSoon';
import { SearchButton } from './SiteSearch';
import { formatEthDisplay, formatPct } from '../lib/tokenFormat';
import { VerifiedMark } from './VerifiedMark';
import { TokenChart } from './TokenChart';
import { TokenTradeSheet } from './TokenTradeSheet';
import { LINK_KINDS, LINK_LABEL } from './AccountProjects';
import { shrinkProjectImage } from '../lib/projectImage';
import type { HolderView } from '../lib/tokenHolders';
import type { ChartRange } from '../lib/tokenMarket';
import type { ActivityRow, TokenSnapshot } from '../lib/tokenMarketServer';
import type { Thesis, ThesisComment, TokenProfile } from '../lib/tokenSocial';
import {
  ArrowLeftIcon,
  BarChartIcon,
  BellIcon,
  BookOpenIcon,
  CandlesIcon,
  CartIcon,
  ChartLineIcon,
  ChatBubblesIcon,
  CheckIcon,
  CloseIcon,
  CoinsIcon,
  CommentIcon,
  CopyIcon,
  DropletIcon,
  ExpandIcon,
  ExternalLinkIcon,
  GithubIcon,
  GlobeIcon,
  HeartIcon,
  MoreVerticalIcon,
  PaperPlaneIcon,
  PencilIcon,
  PeopleIcon,
  PlusIcon,
  StarIcon,
  SwapArrowsIcon,
  TrashIcon,
  TrendUpIcon,
  XLogoIcon,
} from './ExploreIcons';

/**
 * A token's page: price, chart, trade, the pool's figures, recent trades and
 * holders. FLZ, the listed token, also has its profile, watchlist and theses.
 * An imported token opens the same page by its contract, read from its own ETH
 * pool, marked as not verified, and without the FLZ-only parts.
 *
 * Every figure is the pool's own, read from the chain in the last 24 hours
 * (lib/tokenMarketServer.ts). Dollar amounts are marked ≈ and come from one
 * ETH price. Buy and sell use the existing swap, behind the account password.
 */

const UP = 'text-[#2fd27a]';
const DOWN = 'text-[#f05252]';
const CARD = 'rounded-[14px] border border-[#232323] bg-[#101010]';
const SQUARE_BUTTON =
  'hit-y-44 flex h-10 w-10 items-center justify-center rounded-[10px] border sm:h-12 sm:w-12 sm:rounded-[12px] border-[#2a2a2a] bg-[#111111] text-[#e6e6e6] transition-colors hover:border-[#4a4a4a]';
const GHOST_BUTTON =
  'hit-y-44 inline-flex h-10 items-center justify-center gap-2 rounded-[8px] border border-[#383838] px-4 font-sans text-sm text-[#f5f5f5] no-underline transition-colors hover:border-[#5a5a5a] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON =
  'hit-y-44 inline-flex h-11 items-center justify-center gap-2 rounded-[8px] bg-sun px-4 font-sans text-sm font-semibold text-sun-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const FIELD =
  'w-full rounded-[8px] border border-[#383838] bg-[#0d0d0d] px-3 font-sans text-sm text-[#f5f5f5] outline-none transition-colors placeholder:text-[#858585] focus:border-sun/70';

const RANGES: Array<[ChartRange, string]> = [
  ['1h', '1H'],
  ['4h', '4H'],
  ['1d', '1D'],
];

const SENTIMENT_LABEL: Record<string, string> = { bullish: 'Bullish', neutral: 'Neutral', bearish: 'Bearish' };
const SENTIMENT_TONE: Record<string, string> = {
  bullish: 'border-[#2fd27a]/40 bg-[#2fd27a]/10 text-[#2fd27a]',
  neutral: 'border-[#4a4a4a] bg-[#1a1a1a] text-[#cfcfcf]',
  bearish: 'border-[#f05252]/40 bg-[#f05252]/10 text-[#f05252]',
};

function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function ethText(raw: string | number | null | undefined, digits = 6): string {
  const text = formatEthDisplay(raw ?? null, digits);
  return text == null ? 'unavailable' : `${text} ETH`;
}

/** "≈ $8.42" from an ETH amount, or null without a dollar price. */
function usdText(eth: string | number | null | undefined, usdPerEth: number | null): string | null {
  const n = Number(eth);
  if (usdPerEth == null || !Number.isFinite(n)) return null;
  const usd = n * usdPerEth;
  return `≈ $${usd.toLocaleString('en-US', { maximumFractionDigits: usd < 100 ? 2 : 0 })}`;
}

function ago(seconds: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - seconds) / 60));
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function linkIcon(kind: string) {
  if (kind === 'x') return <XLogoIcon size={15} />;
  if (kind === 'telegram') return <PaperPlaneIcon size={16} />;
  if (kind === 'docs') return <BookOpenIcon size={16} />;
  if (kind === 'github') return <GithubIcon size={16} />;
  return <GlobeIcon size={16} />;
}

function Letter({ name, className = '' }: { name: string; className?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full border border-sun/35 bg-sun-wash font-sans font-semibold text-sun ${className}`}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** An imported token as the token route describes it. */
type HeldInfo = { address: string; symbol: string; decimals: number; balance: string | null; chainName: string; explorerBaseUrl: string };

export function TokenDetail({ symbol }: { symbol: string }) {
  const router = useRouter();
  const listed = symbol.toLowerCase() === 'flz';
  /** A token opened by its contract: the same page, its own pool, no listing. */
  const imported = /^0x[0-9a-fA-F]{40}$/.test(symbol);
  const tokenRef = listed ? 'flz' : symbol;
  const [comingSoon, comingSoonNote] = useComingSoon();

  const [range, setRange] = useState<ChartRange>('1d');
  const [chartMode, setChartMode] = useState<'line' | 'candle'>('line');
  const [fullscreen, setFullscreen] = useState(false);
  /** Phones get a shorter chart so the price, chart and trade buttons share one screen. */
  const [phone, setPhone] = useState(false);
  const [market, setMarket] = useState<TokenSnapshot | null>(null);
  const [usdPerEth, setUsdPerEth] = useState<number | null>(null);
  const [marketError, setMarketError] = useState('');
  const [held, setHeld] = useState<HeldInfo | null>(null);
  /** An imported token the swap router has no ETH pool for: no price, no trade. */
  const [noPool, setNoPool] = useState(false);

  const [profile, setProfile] = useState<TokenProfile | null>(null);
  const [watched, setWatched] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const [holderRows, setHolderRows] = useState<HolderView[] | null>(null);
  const [topShare, setTopShare] = useState<string | null>(null);
  const [holderCount, setHolderCount] = useState<number | null>(null);
  const [holderError, setHolderError] = useState('');

  const [theses, setTheses] = useState<Thesis[] | null>(null);
  const [thesisTotal, setThesisTotal] = useState(0);
  const [writing, setWriting] = useState(false);

  const [tab, setTab] = useState<'activity' | 'holders' | 'thesis' | 'about'>('activity');
  const [allActivity, setAllActivity] = useState(false);
  const [now, setNow] = useState(0);

  /** Which side the trade sheet is open on, or null when it is closed. */
  const [tradeSide, setTradeSide] = useState<'buy' | 'sell' | null>(null);

  useEffect(() => setNow(Math.floor(Date.now() / 1000)), [market]);

  const loadMarket = useCallback(async (which: ChartRange) => {
    setMarketError('');
    try {
      const res = await fetch(`/api/tokens/${tokenRef}?range=${which}`);
      const body = await res.json().catch(() => ({}));
      if (body.listedSymbol === 'flz') {
        router.replace('/dashboard/explore/tokens/flz');
        return;
      }
      if (!res.ok) {
        setMarketError(body.error || 'Could not load this token.');
        return;
      }
      if (body.held) setHeld(body.held as HeldInfo);
      setNoPool(imported && !body.market);
      setMarket((body.market ?? null) as TokenSnapshot | null);
      setUsdPerEth(typeof body.usdPerEth === 'number' ? body.usdPerEth : null);
    } catch {
      setMarketError('Could not load this token.');
    }
  }, [tokenRef, imported, router]);

  const loadTheses = useCallback(async () => {
    try {
      const res = await fetch('/api/tokens/flz/theses?limit=20');
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !Array.isArray(body.theses)) return;
      setTheses(body.theses as Thesis[]);
      setThesisTotal(Number(body.total) || 0);
    } catch {
      // The rest of the page does not depend on theses.
    }
  }, []);

  useEffect(() => {
    if (!listed && !imported) return;
    void loadMarket(range);
  }, [listed, imported, range, loadMarket]);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)');
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!listed && !imported) return;
    if (listed) void (async () => {
      try {
        const res = await fetch('/api/tokens/flz/profile');
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.profile) return;
        setProfile(body.profile as TokenProfile);
        setWatched(body.watched === true);
        setCanEdit(body.canEdit === true);
      } catch {
        // Without a profile the page still trades.
      }
    })();
    void (async () => {
      try {
        const res = await fetch(`/api/tokens/${tokenRef}/holders`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.holders) {
          setHolderError('Holders could not be read.');
          return;
        }
        const rows = Array.isArray(body.holders.holders) ? body.holders.holders : [];
        setHolderRows(
          rows
            .filter(
              (row: HolderView) =>
                row && typeof row.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(row.address) && typeof row.amount === 'string'
            )
            .slice(0, 10)
            .map((row: HolderView) => ({ address: row.address, amount: row.amount, label: row.label === 'Pool' ? 'Pool' : null }))
        );
        setTopShare(typeof body.holders.topShare === 'string' ? body.holders.topShare : null);
        setHolderCount(typeof body.holders.count === 'number' ? body.holders.count : null);
      } catch {
        setHolderError('Holders could not be read.');
      }
    })();
    if (listed) void loadTheses();
  }, [listed, imported, tokenRef, loadTheses]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  if (!listed && !imported) {
    return (
      <AppPage>
        <div className="grid w-full gap-3">
          <p className="m-0 text-sm text-muted">This token is not listed.</p>
          <Link href="/dashboard/explore?s=tokens" className="text-sm text-lime no-underline">
            Tokens
          </Link>
        </div>
      </AppPage>
    );
  }

  const day = market?.day ?? null;
  const change24 = formatPct(day?.changePct ?? null);
  const changeUp = (day?.changePct ?? 0) >= 0;
  const activity = market?.activity ?? [];
  const name = listed ? (market?.name && market.name !== 'FLZ' ? market.name : 'Flizy') : market?.name || held?.symbol || 'Token';
  // An imported token is named by its own contract from the first render, so a
  // trade can never fall back to FLZ while the page is still loading.
  const ticker = market?.symbol || held?.symbol || (listed ? 'FLZ' : 'Token');
  const contract = market?.address || held?.address || (imported ? symbol : null);
  /** Trading needs a pool the page has read; an imported token waits for its own. */
  const canTrade = listed || (imported && market != null);
  const explorerBase = market?.explorerBaseUrl || held?.explorerBaseUrl || null;

  async function toggleWatch() {
    const next = !watched;
    setWatched(next);
    try {
      const res = await fetch('/api/tokens/flz/watch', { method: next ? 'POST' : 'DELETE' });
      if (!res.ok) setWatched(!next);
    } catch {
      setWatched(!next);
    }
  }

  async function copyContract() {
    if (!contract) return;
    try {
      await navigator.clipboard.writeText(contract);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard refused (insecure context or permissions): nothing to undo.
    }
  }

  const chart = market ? (
    <TokenChart
      candles={market.candles}
      startPriceEth={market.startPriceEth}
      currentPriceEth={market.priceEth == null ? null : Number(market.priceEth)}
      windowStart={market.windowStart}
      windowEnd={market.windowEnd}
      mode={chartMode}
      height={fullscreen ? 460 : phone ? 200 : 280}
    />
  ) : noPool ? (
    <div className="flex h-[200px] items-center justify-center rounded-[10px] bg-[#141414] px-6 text-center text-sm text-muted sm:h-[280px]">
      The swap has no ETH pool for this token on GIWA, so there is no price, chart or trade.
    </div>
  ) : (
    <div className="h-[200px] animate-pulse sm:h-[280px] rounded-[10px] bg-[#141414]" aria-label="Loading the chart" />
  );

  return (
    <AppPage>
      <div className="grid w-full min-w-0 gap-4 [&>*]:min-w-0">
        {/* Header */}
        <div className="flex items-start gap-3">
          <Link href="/dashboard/explore?s=tokens" className="hit-y-44 mt-1 text-sun sm:mt-2" aria-label="Back to tokens">
            <ArrowLeftIcon size={20} />
          </Link>
          <div className="flex min-w-0 flex-1 items-start gap-2.5 sm:gap-3.5">
            {profile?.logo ? (
              <img src={profile.logo} alt={`${name} logo`} className="h-14 w-14 shrink-0 rounded-[12px] border border-sun/40 object-cover sm:h-[76px] sm:w-[76px] sm:rounded-[16px]" />
            ) : (
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[12px] border border-sun/40 bg-[#0b0b0b] font-sans text-2xl font-bold text-sun sm:h-[76px] sm:w-[76px] sm:rounded-[16px] sm:text-3xl" aria-hidden>
                {name.slice(0, 1).toUpperCase()}.
              </span>
            )}
            <div className="min-w-0">
              <p className="m-0 flex items-center gap-1.5 font-sans text-[22px] font-bold leading-tight text-[#f5f5f5] sm:gap-2 sm:text-[28px]">
                <span className="truncate">{name}</span>
                {listed ? (
                  <span className="scale-[1.15] sm:scale-[1.45]">
                    <VerifiedMark />
                  </span>
                ) : (
                  <span className="shrink-0 rounded-[6px] border border-[#e0a85a]/50 px-1.5 py-0.5 font-sans text-[11px] font-semibold text-[#e0b070]">
                    Not verified
                  </span>
                )}
              </p>
              <p className="m-0 mt-0.5 flex flex-wrap gap-x-2.5 font-sans text-[13px] text-[#a9a9a9] sm:gap-x-3 sm:text-base">
                <span>{ticker}</span>
                {profile?.creatorUsername ? <span>@{profile.creatorUsername}</span> : null}
              </p>
              <p className="m-0 mt-1 flex items-center gap-2 sm:mt-1.5">
                <span className="rounded-[6px] bg-[#1c1c1c] px-1.5 py-0.5 font-mono text-[11px] font-semibold text-[#e6e6e6] sm:px-2 sm:text-xs">GIWA</span>
                <button type="button" onClick={() => void copyContract()} className="hit-y-44 text-[#8f8f8f] hover:text-white" aria-label="Copy the contract address">
                  {copied ? <CheckIcon size={15} className="text-sun" /> : <CopyIcon size={15} />}
                </button>
              </p>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-1.5 sm:gap-2">
            <SearchButton className={SQUARE_BUTTON} iconSize={18} />
            <button type="button" className={`${SQUARE_BUTTON} relative`} aria-label="Notifications" onClick={() => comingSoon('Notifications')}>
              <BellIcon size={18} />
            </button>
            {listed ? (
              <button
                type="button"
                className={`${SQUARE_BUTTON} ${watched ? 'border-sun/60 text-sun' : 'text-sun'}`}
                aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'}
                aria-pressed={watched}
                onClick={() => void toggleWatch()}
              >
                <StarIcon size={18} className={watched ? 'fill-current' : ''} />
              </button>
            ) : null}
            <div className="relative" ref={menuRef}>
              <button type="button" className={SQUARE_BUTTON} aria-label="More" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
                <MoreVerticalIcon size={18} />
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-12 z-30 grid min-w-[210px] sm:top-14 rounded-[10px] border border-[#2c2c2c] bg-[#121212] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.55)]">
                  <MenuButton
                    onClick={() => {
                      setMenuOpen(false);
                      void copyContract();
                    }}
                  >
                    <CopyIcon size={14} /> Copy contract
                  </MenuButton>
                  {contract && explorerBase ? (
                    <a
                      href={`${explorerBase}/address/${contract}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex h-10 items-center gap-2.5 rounded-[7px] px-3 font-sans text-sm text-[#e6e6e6] no-underline hover:bg-[#1c1c1c]"
                    >
                      <ExternalLinkIcon size={14} /> View on explorer
                    </a>
                  ) : null}
                  {canEdit ? (
                    <MenuButton
                      onClick={() => {
                        setMenuOpen(false);
                        setEditing(true);
                      }}
                    >
                      <PencilIcon size={14} /> Edit token profile
                    </MenuButton>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {imported ? (
          <p className="m-0 rounded-[12px] border border-[#e0a85a]/40 bg-[#e0a85a]/10 px-3.5 py-3 text-[13px] leading-relaxed text-[#e0b070]">
            Not verified by Flizy, so it cannot be sent on socials. Anyone can create a token and its pool, and
            pull the pool later. Only trade tokens you know.
          </p>
        ) : null}

        {profile?.description ? <p className="m-0 max-w-[640px] text-[13px] leading-relaxed text-[#d6d6d6] sm:text-[15px]">{profile.description}</p> : null}
        {profile?.links.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
            {profile.links.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer noopener nofollow"
                  className="hit-y-44 inline-flex h-9 items-center gap-1.5 rounded-[8px] border border-[#2e2e2e] bg-[#111111] px-3 font-sans text-[13px] text-[#e6e6e6] sm:h-11 sm:gap-2 sm:rounded-[10px] sm:px-3.5 sm:text-sm no-underline transition-colors hover:border-sun/50"
                >
                  <span className="text-[#cfcfcf]">{linkIcon(link.kind)}</span>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}

        {/* Price */}
        <div className="flex items-start justify-between gap-3 sm:items-end sm:gap-4">
          <div className="min-w-0">
            <p className="m-0 flex flex-wrap items-baseline gap-x-2 sm:gap-x-3">
              <span className="font-sans text-[24px] font-bold leading-tight tracking-wide text-[#f5f5f5] sm:text-[36px]">{ethText(market?.priceEth)}</span>
              {change24 ? (
                <span className={`font-mono text-[13px] sm:text-base ${changeUp ? UP : DOWN}`}>
                  {change24}<span className="hidden sm:inline"> (24h)</span>
                </span>
              ) : null}
            </p>
            <p className="m-0 mt-1 text-[11px] text-[#a9a9a9] sm:text-sm">
              {usdText(market?.priceEth, usdPerEth) ? `${usdText(market?.priceEth, usdPerEth)} · ` : ''}Priced from the ETH pool
            </p>
          </div>
          <dl className="m-0 grid shrink-0 grid-cols-[auto_auto] gap-x-3 gap-y-1 font-mono text-[11px] sm:gap-x-6 sm:text-sm">
            <dt className="text-[#8f8f8f]">24h High</dt>
            <dd className="m-0 text-right text-[#f0f0f0]">{day?.high == null ? '-' : formatEthDisplay(day.high, 6)}</dd>
            <dt className="text-[#8f8f8f]">24h Low</dt>
            <dd className="m-0 text-right text-[#f0f0f0]">{day?.low == null ? '-' : formatEthDisplay(day.low, 6)}</dd>
            <dt className="text-[#8f8f8f]">24h Vol</dt>
            <dd className="m-0 text-right text-[#f0f0f0]">{day ? ethText(day.volumeEth, 4) : '-'}</dd>
          </dl>
        </div>

        {marketError ? <p className="alert alert-error">{marketError}</p> : null}

        {/* Chart */}
        <section className={`${CARD} p-3 min-[640px]:p-4`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex gap-1" role="tablist" aria-label="Chart range">
              {RANGES.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={range === id}
                  onClick={() => setRange(id)}
                  className={`hit-y-44 h-9 min-w-[42px] rounded-[8px] px-2 font-mono text-[13px] transition-colors sm:h-10 sm:min-w-[52px] sm:rounded-[9px] sm:px-3 sm:text-sm ${
                    range === id ? 'bg-sun-wash text-sun' : 'text-[#bdbdbd] hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setChartMode((m) => (m === 'line' ? 'candle' : 'line'))}
                className={`hit-y-44 flex h-9 w-10 items-center justify-center rounded-[8px] sm:h-10 sm:w-11 sm:rounded-[9px] ${chartMode === 'candle' ? 'bg-sun-wash text-sun' : 'bg-[#161616] text-[#e0a85a]'}`}
                aria-label={chartMode === 'line' ? 'Show candles' : 'Show line'}
                aria-pressed={chartMode === 'candle'}
              >
                {chartMode === 'line' ? <CandlesIcon size={18} /> : <ChartLineIcon size={18} />}
              </button>
              <button
                type="button"
                onClick={() => setFullscreen(true)}
                className="hit-y-44 flex h-9 w-10 items-center justify-center rounded-[8px] border border-[#2e2e2e] text-[#e6e6e6] sm:h-10 sm:w-11 sm:rounded-[9px]"
                aria-label="Full screen chart"
              >
                <ExpandIcon size={17} />
              </button>
            </div>
          </div>
          {chart}
          <p className="m-0 mt-2 text-[11px] text-muted">
            Read from the last 24 hours of the GIWA pool. Longer ranges need trade history Flizy does not store yet.
          </p>
        </section>

        {/* Trade */}
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3">
          <button
            type="button"
            onClick={() => setTradeSide('buy')}
            disabled={!canTrade}
            className="hit-y-44 flex h-12 items-center justify-center gap-2 rounded-[12px] border border-[#2fd27a]/60 bg-[#2fd27a]/10 font-sans text-base font-semibold sm:h-14 sm:gap-2.5 sm:text-lg text-[#2fd27a] transition-colors hover:bg-[#2fd27a]/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CartIcon size={20} /> Buy {ticker}
          </button>
          <button
            type="button"
            onClick={() => setTradeSide('sell')}
            disabled={!canTrade}
            className="hit-y-44 flex h-12 items-center justify-center gap-2 rounded-[12px] border border-[#f05252]/60 bg-[#f05252]/10 font-sans text-base font-semibold sm:h-14 sm:gap-2.5 sm:text-lg text-[#f05252] transition-colors hover:bg-[#f05252]/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SwapArrowsIcon size={20} /> Sell {ticker}
          </button>
        </div>

        {/* Figures */}
        <section className="grid grid-cols-3 gap-2 sm:gap-2.5">
          <Figure icon={<CoinsIcon size={18} />} label="Market Cap" value={ethText(market?.marketCapEth, 4)} sub={usdText(market?.marketCapEth, usdPerEth)} />
          <Figure icon={<DropletIcon size={18} />} label="Liquidity" value={ethText(market?.liquidityEth, 4)} sub={usdText(market?.liquidityEth, usdPerEth)} />
          <Figure icon={<PeopleIcon size={18} />} label="Holders" value={holderCount == null ? '-' : holderCount.toLocaleString('en-US')} />
          <Figure
            icon={<BarChartIcon size={18} />}
            label="Volume (24h)"
            value={day ? ethText(day.volumeEth, 4) : '-'}
            sub={day ? usdText(day.volumeEth, usdPerEth) : null}
          />
          <Figure
            icon={<SwapArrowsIcon size={18} />}
            label="Trades (24h)"
            value={day ? String(day.trades) : '-'}
            sub={
              day ? (
                <>
                  <span className={UP}>{day.buys} buy</span> <span className={DOWN}>{day.sells} sell</span>
                </>
              ) : null
            }
          />
          <Figure
            icon={<TrendUpIcon size={18} />}
            label="Price Change (24h)"
            value={<span className={change24 ? (changeUp ? UP : DOWN) : ''}>{change24 ?? 'No trades'}</span>}
          />
        </section>

        {/* Tabs */}
        <div role="tablist" aria-label="Token" className={`grid border-b border-[#232323] ${listed ? 'grid-cols-4' : 'grid-cols-3'}`}>
          {(
            [
              ['activity', 'Activity'],
              ['holders', 'Holders'],
              ['thesis', 'Thesis'],
              ['about', 'About'],
            ] as const
          )
            .filter(([id]) => listed || id !== 'thesis')
            .map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`hit-y-44 -mb-px flex h-11 items-center justify-center gap-1.5 border-b-2 font-sans text-[13px] transition-colors sm:h-12 sm:gap-2 sm:text-[15px] ${
                tab === id ? 'border-sun text-sun' : 'border-transparent text-[#cfcfcf] hover:text-white'
              }`}
            >
              {label}
              {id === 'thesis' ? (
                <span className="rounded-full bg-[#2a2a2a] px-1.5 py-0.5 font-mono text-[10px] text-[#cfcfcf] sm:text-[11px]">{thesisTotal}</span>
              ) : null}
            </button>
          ))}
        </div>

        <div role="tabpanel">
          {tab === 'activity' ? (
            <ActivityCard rows={allActivity ? activity : activity.slice(0, 4)} now={now} onAll={() => setAllActivity((v) => !v)} showingAll={allActivity} total={activity.length} />
          ) : tab === 'holders' ? (
            <section className={`${CARD} p-4`}>
              {holderError ? <p className="alert alert-error">{holderError}</p> : null}
              {!holderRows && !holderError ? <p className="m-0 text-sm text-muted">Reading holders...</p> : null}
              {holderRows ? (
                <>
                  <p className="m-0 text-sm text-[#e6e6e6]">
                    {holderRows.length === 0 ? 'No holders were read.' : topShare ? `Top ${holderRows.length} hold ${topShare}` : 'Top share could not be read.'}
                  </p>
                  <ol className="m-0 mt-3 grid list-none gap-1 p-0">
                    {holderRows.map((row, index) => (
                      <li key={row.address} className="flex items-center gap-3 border-b border-[#1c1c1c] py-2.5 last:border-0">
                        <span className="w-6 font-mono text-xs text-[#8f8f8f]">{index + 1}</span>
                        <a
                          href={explorerBase ? `${explorerBase}/address/${row.address}` : undefined}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="min-w-0 flex-1 truncate font-mono text-sm text-sun no-underline"
                        >
                          {row.label ? `${row.label} ${shortAddress(row.address)}` : shortAddress(row.address)}
                        </a>
                        <span className="font-mono text-sm text-[#e6e6e6]">{row.amount} {ticker}</span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
            </section>
          ) : tab === 'thesis' ? (
            <ThesisCard theses={theses} total={thesisTotal} onWrite={() => setWriting(true)} onChanged={() => void loadTheses()} full />
          ) : (
            <section className={`${CARD} p-5`}>
              <h2 className="m-0 font-sans text-lg font-semibold text-[#f5f5f5]">About {name}</h2>
              {profile?.description ? <p className="m-0 mt-2 text-sm leading-relaxed text-[#d0d0d0]">{profile.description}</p> : null}
              <dl className="m-0 mt-4 grid gap-2.5 text-sm">
                {contract && explorerBase ? (
                  <AboutRow label="Contract">
                    <a href={`${explorerBase}/address/${contract}`} target="_blank" rel="noreferrer noopener" className="text-sun no-underline">
                      {shortAddress(contract)}
                    </a>
                  </AboutRow>
                ) : null}
                {market ? (
                  <>
                    <AboutRow label="Pool">
                      <a href={`${market.explorerBaseUrl}/address/${market.pair}`} target="_blank" rel="noreferrer noopener" className="text-sun no-underline">
                        {shortAddress(market.pair)}
                      </a>
                    </AboutRow>
                    <AboutRow label="Chain">{market.chainName}</AboutRow>
                  </>
                ) : null}
                {profile?.creatorUsername ? <AboutRow label="Creator">@{profile.creatorUsername}</AboutRow> : null}
                <AboutRow label="Status">{listed ? 'Verified. It can be sent on socials.' : 'Not verified. It cannot be sent on socials.'}</AboutRow>
              </dl>
            </section>
          )}
        </div>

        {listed && tab !== 'thesis' ? (
          <ThesisCard theses={theses ? theses.slice(0, 2) : null} total={thesisTotal} onWrite={() => setWriting(true)} onChanged={() => void loadTheses()} />
        ) : null}
      </div>

      {fullscreen ? (
        <Sheet title="Price chart" onClose={() => setFullscreen(false)} wide>
          <div className="mb-3 flex gap-1">
            {RANGES.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setRange(id)}
                className={`hit-y-44 h-10 min-w-[52px] rounded-[9px] px-3 font-mono text-sm ${range === id ? 'bg-sun-wash text-sun' : 'text-[#bdbdbd]'}`}
              >
                {label}
              </button>
            ))}
          </div>
          {chart}
        </Sheet>
      ) : null}

      {tradeSide ? (
        <TokenTradeSheet
          side={tradeSide}
          onSide={setTradeSide}
          onClose={() => setTradeSide(null)}
          // Balances and history follow the sheet's announceTx; only the market is this page's.
          onTraded={() => void loadMarket(range)}
          symbol={ticker}
          logo={profile?.logo ?? null}
          priceEth={market?.priceEth == null ? null : Number(market.priceEth)}
          change24={change24}
          changeUp={changeUp}
          usdPerEth={usdPerEth}
          tokenAddress={imported ? contract : null}
        />
      ) : null}

      {writing ? (
        <WriteThesisSheet
          onClose={() => setWriting(false)}
          onPosted={() => {
            setWriting(false);
            void loadTheses();
            setTab('thesis');
          }}
        />
      ) : null}

      {editing && profile ? (
        <EditProfileSheet
          profile={profile}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setProfile(saved);
            setEditing(false);
          }}
        />
      ) : null}
      {comingSoonNote}
    </AppPage>
  );
}

function MenuButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-10 items-center gap-2.5 rounded-[7px] px-3 text-left font-sans text-sm text-[#e6e6e6] hover:bg-[#1c1c1c]">
      {children}
    </button>
  );
}

function Figure({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className={`${CARD} flex min-w-0 flex-col gap-1.5 p-2.5 sm:flex-row sm:items-start sm:gap-3 sm:p-3.5`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-[#171410] text-sun sm:h-11 sm:w-11 sm:rounded-[10px]">{icon}</span>
      <div className="min-w-0">
        <p className="m-0 truncate font-sans text-[11px] text-[#bdbdbd] sm:text-[13px]">{label}</p>
        <p className="m-0 mt-0.5 truncate font-sans text-[13px] font-semibold text-[#f5f5f5] min-[380px]:text-[14px] sm:text-[19px]">{value}</p>
        {sub ? <p className="m-0 mt-0.5 truncate font-mono text-[10px] text-[#a9a9a9] sm:text-xs">{sub}</p> : null}
      </div>
    </div>
  );
}

function AboutRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#1c1c1c] pb-2.5 last:border-0 last:pb-0">
      <dt className="text-[#8f8f8f]">{label}</dt>
      <dd className="m-0 text-right font-mono text-[#e6e6e6]">{children}</dd>
    </div>
  );
}

function ActivityCard({
  rows,
  now,
  onAll,
  showingAll,
  total,
}: {
  rows: ActivityRow[];
  now: number;
  onAll: () => void;
  showingAll: boolean;
  total: number;
}) {
  return (
    <section className={`${CARD} p-3.5 sm:p-4`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 flex min-w-0 items-center gap-2 font-sans text-[15px] font-semibold text-[#f5f5f5] sm:gap-2.5 sm:text-lg">
          <SwapArrowsIcon size={18} className="text-sun" /> Recent activity
        </h2>
        {total > 4 ? (
          <button type="button" onClick={onAll} className={GHOST_BUTTON}>
            {showingAll ? 'Show fewer' : 'View all'}
          </button>
        ) : null}
      </div>
      {rows.length ? (
        <div className="mt-3">
          <table className="w-full table-fixed border-collapse font-mono text-[11px] min-[480px]:text-sm">
            <thead>
              <tr className="text-left font-sans text-[11px] text-[#a9a9a9] min-[480px]:text-[13px]">
                <th className="w-[24%] py-2 font-normal">Time</th>
                <th className="w-[13%] py-2 font-normal">Type</th>
                <th className="py-2 font-normal">
                  <span className="min-[480px]:hidden">ETH</span>
                  <span className="hidden min-[480px]:inline">Amount (ETH)</span>
                </th>
                <th className="py-2 font-normal">
                  <span className="min-[480px]:hidden">FLZ</span>
                  <span className="hidden min-[480px]:inline">Amount (FLZ)</span>
                </th>
                <th className="w-[24%] py-2 font-normal">User</th>
                <th className="w-7 py-2" aria-label="Transaction" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.txHash + r.time} className="border-t border-[#1c1c1c]">
                  <td className="py-2.5 text-[#cfcfcf]">
                    <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full min-[480px]:mr-2 min-[480px]:h-2 min-[480px]:w-2 ${r.side === 'buy' ? 'bg-[#2fd27a]' : 'bg-[#f05252]'}`} aria-hidden />
                    {now ? ago(r.time, now) : ''}
                  </td>
                  <td className={`py-2.5 ${r.side === 'buy' ? UP : DOWN}`}>{r.side === 'buy' ? 'Buy' : 'Sell'}</td>
                  <td className="py-2.5 text-[#f0f0f0]">{formatEthDisplay(r.ethAmount, 4) ?? '-'}</td>
                  <td className="py-2.5 text-[#f0f0f0]">{r.flzAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td>
                  <td className="truncate py-2.5 text-sun">{r.trader ? shortAddress(r.trader) : '-'}</td>
                  <td className="py-2.5 text-right">
                    <a href={r.txUrl} target="_blank" rel="noreferrer noopener" className="text-[#a9a9a9] hover:text-white" aria-label="View transaction">
                      <ExternalLinkIcon size={15} />
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="m-0 mt-3 text-sm text-muted">No trades in the last 24 hours.</p>
      )}
    </section>
  );
}

function ThesisCard({
  theses,
  total,
  onWrite,
  onChanged,
  full = false,
}: {
  theses: Thesis[] | null;
  total: number;
  onWrite: () => void;
  onChanged: () => void;
  full?: boolean;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => setNow(Math.floor(Date.now() / 1000)), [theses]);
  return (
    <section className={`${CARD} p-3.5 sm:p-4`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 flex min-w-0 items-center gap-2 font-sans text-[15px] font-semibold text-[#f5f5f5] sm:gap-2.5 sm:text-lg">
          <ChatBubblesIcon size={18} className="shrink-0 text-sun" /> <span className="truncate">Community thesis ({total})</span>
        </h2>
        <button
          type="button"
          onClick={onWrite}
          className="hit-y-44 inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[8px] border border-sun/50 px-3 font-sans text-[13px] text-sun hover:bg-sun-wash sm:h-10 sm:gap-2 sm:px-3.5 sm:text-sm"
        >
          <PencilIcon size={14} /> Write a thesis
        </button>
      </div>
      {theses === null ? (
        <p className="m-0 mt-3 text-sm text-muted">Loading theses...</p>
      ) : theses.length ? (
        <ul className="m-0 mt-2 list-none p-0">
          {theses.map((t) => (
            <ThesisItem key={t.id} thesis={t} now={now} onChanged={onChanged} />
          ))}
        </ul>
      ) : (
        <p className="m-0 mt-3 text-sm text-muted">No theses yet. Say what you think of this token.</p>
      )}
      {!full && total > (theses?.length || 0) ? <p className="m-0 mt-1 text-xs text-muted">Open the Thesis tab to read all {total}.</p> : null}
    </section>
  );
}

function ThesisItem({ thesis, now, onChanged }: { thesis: Thesis; now: number; onChanged: () => void }) {
  const [liked, setLiked] = useState(thesis.likedByViewer);
  const [likes, setLikes] = useState(thesis.likes);
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<ThesisComment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const base = `/api/tokens/flz/theses/${encodeURIComponent(thesis.id)}`;
  const createdAt = Math.floor(new Date(thesis.createdAt).getTime() / 1000);

  async function like() {
    try {
      const res = await fetch(`${base}/like`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && typeof body.likes === 'number') {
        setLiked(body.liked === true);
        setLikes(body.likes);
      }
    } catch {
      // The count stays as it was.
    }
  }

  async function loadComments() {
    const next = !open;
    setOpen(next);
    if (!next || comments) return;
    try {
      const res = await fetch(`${base}/comments`);
      const body = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(body.comments)) setComments(body.comments as ThesisComment[]);
    } catch {
      setError('Could not load comments.');
    }
  }

  async function send() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`${base}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: draft }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.comment) {
        setError(typeof body.error === 'string' ? body.error : 'Could not post that.');
        return;
      }
      setComments((prev) => [...(prev || []), body.comment as ThesisComment]);
      setDraft('');
      onChanged();
    } catch {
      setError('Could not post that.');
    } finally {
      setBusy(false);
    }
  }

  /** True only when the server removed it, so nothing disappears that is still there. */
  async function remove(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        setError('Could not delete that.');
        return false;
      }
      onChanged();
      return true;
    } catch {
      setError('Could not delete that.');
      return false;
    }
  }

  return (
    <li className="grid grid-cols-[40px_1fr] gap-2.5 border-b sm:grid-cols-[52px_1fr] sm:gap-3 border-[#1c1c1c] py-4 last:border-0">
      <Letter name={thesis.username} className="h-10 w-10 text-base sm:h-[52px] sm:w-[52px] sm:text-lg" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="m-0">
            <span className="font-sans text-sm text-[#f5f5f5] sm:text-base">{thesis.username}</span>
            <span className="ml-2 text-xs text-[#8f8f8f]">{now ? ago(createdAt, now) : ''}</span>
          </p>
          <span className={`inline-flex items-center rounded-[6px] border px-2 py-0.5 font-sans text-[12px] sm:text-[13px] ${SENTIMENT_TONE[thesis.sentiment]}`}>
            {SENTIMENT_LABEL[thesis.sentiment]}
          </span>
        </div>
        <p className="m-0 mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[#e6e6e6] sm:text-[15px]">{thesis.body}</p>
        <div className="mt-2 flex items-center gap-5 text-[#bdbdbd]">
          <button type="button" onClick={() => void like()} className="hit-y-44 inline-flex items-center gap-1.5 font-mono text-sm" aria-pressed={liked}>
            <HeartIcon size={18} filled={liked} className={liked ? 'text-[#f05252]' : ''} /> {likes}
          </button>
          <button type="button" onClick={() => void loadComments()} className="hit-y-44 inline-flex items-center gap-1.5 font-mono text-sm" aria-expanded={open}>
            <CommentIcon size={18} /> {thesis.comments}
          </button>
          {thesis.canDelete ? (
            <div className="relative ml-auto">
              <button type="button" onClick={() => setMenu((m) => !m)} className="hit-y-44 text-[#8f8f8f]" aria-label="Thesis options">
                <MoreVerticalIcon size={16} />
              </button>
              {menu ? (
                <div className="absolute right-0 top-7 z-20 rounded-[8px] border border-[#2c2c2c] bg-[#121212] p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(false);
                      void remove(base);
                    }}
                    className="flex h-9 items-center gap-2 rounded-[6px] px-3 font-sans text-sm text-[#f05252] hover:bg-[#1c1c1c]"
                  >
                    <TrashIcon size={14} /> Delete
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {open ? (
          <div className="mt-3 grid gap-2 border-l border-[#2a2a2a] pl-3">
            {(comments || []).map((cm) => (
              <div key={cm.id} className="flex items-start justify-between gap-2">
                <p className="m-0 text-sm text-[#d6d6d6]">
                  <span className="text-[#f5f5f5]">{cm.username}</span> {cm.body}
                </p>
                {cm.canDelete ? (
                  <button type="button" onClick={() =>
                      void remove(`${base}/comments/${encodeURIComponent(cm.id)}`).then((removed) => {
                        if (removed) setComments((p) => (p || []).filter((x) => x.id !== cm.id));
                      })
                    } className="text-[#8f8f8f] hover:text-[#f05252]" aria-label="Delete comment">
                    <TrashIcon size={13} />
                  </button>
                ) : null}
              </div>
            ))}
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={300}
                placeholder="Add a comment"
                aria-label="Add a comment"
                className={`${FIELD} h-10 flex-1`}
              />
              <button type="button" onClick={() => void send()} disabled={busy || !draft.trim()} className={PRIMARY_BUTTON}>
                Post
              </button>
            </div>
          </div>
        ) : null}
        {error ? <p className="m-0 mt-2 text-xs text-[#e0b070]" role="alert">{error}</p> : null}
      </div>
    </li>
  );
}

function Sheet({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-[2px] sm:items-center" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className={`max-h-[92dvh] w-full overflow-y-auto rounded-t-[20px] border border-b-0 border-[#3a2a1c] bg-[#101011] px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-4 shadow-[0_-20px_60px_rgba(0,0,0,0.6)] sm:rounded-[20px] sm:border-b ${
          wide ? 'max-w-[1000px]' : 'max-w-[480px]'
        }`}
      >
        <div className="mx-auto mb-4 h-[4px] w-[38px] rounded-full bg-[#2c2d33] sm:hidden" aria-hidden />
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="m-0 font-sans text-lg font-bold text-white">
            {title}
          </h2>
          <button type="button" onClick={onClose} className="hit-y-44 inline-flex h-8 w-8 items-center justify-center rounded-[6px] text-[#a9a9a9] hover:text-white" aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

function WriteThesisSheet({ onClose, onPosted }: { onClose: () => void; onPosted: () => void }) {
  const [sentiment, setSentiment] = useState<'bullish' | 'neutral' | 'bearish'>('bullish');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function post() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/tokens/flz/theses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sentiment, body }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof out.error === 'string' ? out.error : 'Could not post that.');
        return;
      }
      onPosted();
    } catch {
      setError('Could not post that.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Write a thesis" onClose={() => !busy && onClose()}>
      <p className="m-0 font-sans text-xs text-[#a9a9a9]">Your view</p>
      <div className="mt-1.5 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Your view">
        {(['bullish', 'neutral', 'bearish'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={sentiment === s}
            onClick={() => setSentiment(s)}
            className={`hit-y-44 h-11 rounded-[8px] border font-sans text-sm ${sentiment === s ? SENTIMENT_TONE[s] : 'border-[#2e2e2e] text-[#bdbdbd]'}`}
          >
            {SENTIMENT_LABEL[s]}
          </button>
        ))}
      </div>
      <label className="mt-4 block font-sans text-xs text-[#a9a9a9]" htmlFor="thesis-body">
        Thesis
      </label>
      <textarea
        id="thesis-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={500}
        rows={5}
        placeholder="Why do you hold, watch or avoid this token?"
        className={`${FIELD} mt-1.5 resize-none py-2.5 leading-relaxed`}
      />
      <p className="m-0 mt-1 text-right font-mono text-[11px] text-[#6f6f6f]">{body.length}/500</p>
      <p className="m-0 mt-1 text-xs text-muted">Shown with your @username. Not financial advice, and others will read it that way too.</p>
      {error ? (
        <p className="m-0 mt-3 text-sm text-[#e0b070]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" className={GHOST_BUTTON} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={PRIMARY_BUTTON} onClick={() => void post()} disabled={busy || !body.trim()}>
          {busy ? 'Posting' : 'Post thesis'}
        </button>
      </div>
    </Sheet>
  );
}

type LinkRow = { id: number; kind: string; url: string };

function EditProfileSheet({
  profile,
  onClose,
  onSaved,
}: {
  profile: TokenProfile;
  onClose: () => void;
  onSaved: (saved: TokenProfile) => void;
}) {
  const [logo, setLogo] = useState<string | null>(profile.logo);
  const [description, setDescription] = useState(profile.description);
  const [creator, setCreator] = useState(profile.creatorUsername || '');
  const [rows, setRows] = useState<LinkRow[]>(() => profile.links.map((l, i) => ({ id: i + 1, kind: l.kind, url: l.url })));
  const nextId = useRef(profile.links.length + 1);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function pick(file: File | undefined) {
    if (!file) return;
    try {
      setLogo(await shrinkProjectImage(file));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that image.');
    }
  }

  async function save() {
    if (busy) return;
    const links = rows
      .filter((r) => r.url.trim())
      .map((r) => ({ kind: r.kind, label: LINK_LABEL[r.kind] || 'Link', url: r.url.trim() }));
    if (links.some((l) => !/^https:\/\//i.test(l.url))) {
      setError('Links must start with https.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/tokens/flz/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ logo, description, links, creatorUsername: creator.trim() || null }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.profile) {
        setError(typeof out.error === 'string' ? out.error : 'Could not save the profile.');
        return;
      }
      onSaved(out.profile as TokenProfile);
    } catch {
      setError('Could not save the profile.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Edit token profile" onClose={() => !busy && onClose()}>
      <div className="flex items-center gap-4">
        {logo ? (
          <img src={logo} alt="Token logo" className="h-16 w-16 rounded-[14px] border border-sun/40 object-cover" />
        ) : (
          <span className="flex h-16 w-16 items-center justify-center rounded-[14px] border border-sun/40 font-sans text-2xl font-bold text-sun">F.</span>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={GHOST_BUTTON} onClick={() => fileRef.current?.click()} disabled={busy}>
            {logo ? 'Change logo' : 'Add logo'}
          </button>
          {logo ? (
            <button type="button" className={GHOST_BUTTON} onClick={() => setLogo(null)} disabled={busy}>
              Remove
            </button>
          ) : null}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      <label className="mt-5 block font-sans text-xs text-[#a9a9a9]" htmlFor="token-description">
        Description
      </label>
      <textarea
        id="token-description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        maxLength={500}
        rows={3}
        className={`${FIELD} mt-1.5 resize-none py-2.5 leading-relaxed`}
      />

      <label className="mt-4 block font-sans text-xs text-[#a9a9a9]" htmlFor="token-creator">
        Creator @username
      </label>
      <input id="token-creator" value={creator} onChange={(e) => setCreator(e.target.value)} placeholder="@username" className={`${FIELD} mt-1.5 h-11`} />

      <p className="m-0 mt-4 font-sans text-xs text-[#a9a9a9]">Links</p>
      <div className="mt-1.5 grid gap-2">
        {rows.map((row) => (
          <div key={row.id} className="flex gap-2">
            <select
              aria-label="Link type"
              value={row.kind}
              onChange={(e) => setRows((p) => p.map((r) => (r.id === row.id ? { ...r, kind: e.target.value } : r)))}
              className="h-10 w-[112px] shrink-0 rounded-[8px] border border-[#383838] bg-[#0d0d0d] px-2 font-sans text-sm text-[#f5f5f5]"
            >
              {LINK_KINDS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              aria-label="Link address"
              value={row.url}
              onChange={(e) => setRows((p) => p.map((r) => (r.id === row.id ? { ...r, url: e.target.value } : r)))}
              placeholder="https://"
              className={`${FIELD} h-10 min-w-0 flex-1`}
            />
            <button
              type="button"
              onClick={() => setRows((p) => p.filter((r) => r.id !== row.id))}
              className="hit-y-44 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] border border-[#2e2e2e] text-[#8f8f8f]"
              aria-label="Remove link"
            >
              <TrashIcon size={14} />
            </button>
          </div>
        ))}
        {rows.length < 8 ? (
          <button
            type="button"
            onClick={() => {
              const id = nextId.current++;
              setRows((p) => [...p, { id, kind: 'website', url: '' }]);
            }}
            className="hit-y-44 inline-flex h-9 w-fit items-center gap-1.5 font-sans text-sm text-sun"
          >
            <PlusIcon size={13} /> Add link
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="m-0 mt-3 text-sm text-[#e0b070]" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-5 grid grid-cols-2 gap-2">
        <button type="button" className={GHOST_BUTTON} onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={PRIMARY_BUTTON} onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving' : 'Save profile'}
        </button>
      </div>
    </Sheet>
  );
}
