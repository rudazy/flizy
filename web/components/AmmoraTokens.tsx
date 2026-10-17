'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  filterLaunches,
  launchPhase,
  type LaunchFilter,
  type LaunchSort,
} from '../lib/ammora/launchList';
import { ArrowRightIcon, CopyIcon, ExternalLinkIcon, SearchIcon } from './ExploreIcons';

/**
 * Explore > Tokens > Ammora launches. Its own view, not a block under
 * Discover. Shown only when NEXT_PUBLIC_AMMORA_ENABLED is "true"; otherwise
 * this renders nothing and makes no request.
 *
 * These are third-party launches. Only a token Ammora would route right now
 * gets a Trade button, and that opens the same token page Flizy tokens use.
 * Buy and Sell on that page go through Ammora. The catalog has no dollar price and no market cap,
 * so those cells stay empty. Names and
 * symbols arrive sanitized from the server and React renders them as text.
 * A logo is the image Ammora published for that token. A token without one
 * keeps the letter.
 */

type AmmoraTokenView = {
  address: string;
  symbol: string;
  name: string;
  status: string;
  tradable: boolean;
  label: string;
  image?: string | null;
};

export function ammoraUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AMMORA_ENABLED === 'true';
}

const AMMORA_SITE = 'https://ammora.org';

const PHASES: Array<{ id: LaunchFilter; label: string; dot: string | null }> = [
  { id: 'all', label: 'All', dot: null },
  { id: 'active', label: 'Active', dot: '#3ddc84' },
  { id: 'upcoming', label: 'Upcoming', dot: '#c084fc' },
  { id: 'not_tradable', label: 'Not tradable', dot: '#8a8a90' },
];

const SORTS: Array<{ id: LaunchSort; label: string }> = [
  { id: 'active', label: 'Active first' },
  { id: 'name', label: 'Name' },
  { id: 'name_desc', label: 'Name, Z to A' },
];

const AVATAR = ['#e0b84a', '#3ddc84', '#e85d4c', '#c084fc', '#f0a04b', '#e879a9', '#c4c4c8'];

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

function avatarColor(address: string): string {
  let n = 0;
  for (let i = 0; i < address.length; i += 1) n = (n + address.charCodeAt(i)) % AVATAR.length;
  return AVATAR[n];
}

export function AmmoraTokens() {
  const enabled = ammoraUiEnabled();
  const [tokens, setTokens] = useState<AmmoraTokenView[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<LaunchFilter>('all');
  const [sort, setSort] = useState<LaunchSort>('active');
  const [sortOpen, setSortOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch('/api/ammora/tokens', { cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || body.unavailable) {
          setUnavailable(true);
          setTokens([]);
        } else {
          setTokens(Array.isArray(body.tokens) ? body.tokens : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUnavailable(true);
          setTokens([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const shown = useMemo(
    () => filterLaunches(tokens || [], { phase, query, sort }),
    [tokens, phase, query, sort]
  );

  if (!enabled) return null;

  return (
    <div className="grid gap-[12px]">
      <Hero />
      <div className="flex gap-[8px]">
        <label className="flex h-[40px] min-w-0 flex-1 items-center gap-[10px] rounded-[10px] border border-[#2a2b30] bg-[#0d0d0e] px-[12px] focus-within:border-[#6e2c72]">
          <SearchIcon size={15} className="shrink-0 text-[#bdbdbd]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tokens, contract or symbol..."
            aria-label="Search Ammora launches"
            className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-white outline-none placeholder:text-[#8a8a8f]"
          />
        </label>
        <div className="relative shrink-0">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((open) => !open)}
            className="hit-y-44 flex h-[40px] items-center gap-[7px] rounded-[10px] border border-[#2a2b30] bg-[#0d0d0e] px-[12px] font-sans text-[12px] text-white"
          >
            <SortIcon />
            Sort
            <Caret />
          </button>
          {sortOpen ? (
            <ul
              role="listbox"
              aria-label="Sort"
              className="absolute right-0 z-20 mt-[4px] w-[148px] list-none rounded-[8px] border border-[#2a2b30] bg-[#121214] p-[4px] shadow-lg"
            >
              {SORTS.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={sort === item.id}
                    onClick={() => {
                      setSort(item.id);
                      setSortOpen(false);
                    }}
                    className={`block w-full rounded-[6px] px-[10px] py-[8px] text-left font-sans text-[12px] ${
                      sort === item.id ? 'bg-[#6e2c72] text-white' : 'text-[#e6e6e6] hover:bg-[#1c1c20]'
                    }`}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div
        className="-mx-4 flex gap-[8px] overflow-x-auto px-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="tablist"
        aria-label="Launch status"
      >
        {PHASES.map((item) => {
          const active = phase === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setPhase(item.id)}
              className={`hit-y-44 inline-flex h-[32px] shrink-0 items-center gap-[6px] rounded-full border px-[12px] font-sans text-[12px] font-medium ${
                active
                  ? item.id === 'all'
                    ? 'border-transparent bg-[#f7d043] text-[#1a1405]'
                    : 'border-[#f7d043] bg-transparent text-white'
                  : 'border-[#2a2b30] bg-[#141416] text-[#d4d4d4]'
              }`}
            >
              {item.dot ? <span className="h-[7px] w-[7px] rounded-full" style={{ background: item.dot }} aria-hidden /> : null}
              {item.label}
            </button>
          );
        })}
      </div>

      {tokens === null ? <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">Loading...</p> : null}
      {tokens !== null && shown.length === 0 ? (
        <p className="m-0 rounded-[12px] border border-[#1f1f22] bg-[#0c0c0d] px-[14px] py-[14px] font-sans text-[12px] text-[#a9a9a9]">
          {unavailable
            ? 'Ammora launches are unavailable right now.'
            : tokens.length === 0
              ? 'No Ammora launches yet.'
              : 'No Ammora launch matches.'}
        </p>
      ) : null}
      <ul className="m-0 grid list-none gap-[8px] p-0">
        {shown.map((token) => (
          <LaunchRow key={token.address} token={token} />
        ))}
      </ul>
    </div>
  );
}

function Hero() {
  return (
    <section
      className="relative min-h-[176px] overflow-hidden rounded-[16px] border border-[#3a2458]"
      style={{ background: 'radial-gradient(120% 140% at 0% 0%, #3a1460 0%, #1a0c28 42%, #0c0a10 100%)' }}
    >
      <div className="pointer-events-none absolute inset-y-0 right-0 w-[48%]">
        <Image
          src="/explore/ammora-coin.jpg"
          alt=""
          fill
          sizes="190px"
          className="object-contain object-right mix-blend-lighten"
        />
      </div>
      <span className="absolute right-[10px] top-[10px] z-[1] rounded-full border border-[#c084fc]/70 bg-[#1a1028]/80 px-[8px] py-[3px] font-sans text-[10px] text-[#f0d9ff]">
        External venue
      </span>
      <div className="relative flex min-h-[176px] max-w-[68%] flex-col px-[14px] py-[14px]">
        <div className="flex items-center gap-[8px]">
          <span className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[8px] bg-[#6e2c72] font-sans text-[16px] font-bold text-white">
            A
          </span>
          <h2 className="m-0 font-sans text-[18px] font-bold text-white">Ammora launches</h2>
          <a
            href={AMMORA_SITE}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Ammora site"
            className="text-[#e7d4f5]"
          >
            <ExternalLinkIcon size={14} />
          </a>
        </div>
        <p className="m-0 mt-[8px] font-sans text-[12px] leading-[16px] text-[#e4d7ef]">
          Tokens launched on Ammora, a separate venue on GIWA. Flizy has not reviewed these tokens. Check the contract before you trade.
        </p>
        <a
          href={AMMORA_SITE}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-auto inline-flex h-[34px] w-fit items-center gap-[8px] rounded-[8px] border border-[#6a4a86] bg-[#140c1c]/70 px-[12px] font-sans text-[12px] font-medium text-white no-underline"
        >
          Learn about Ammora
          <ArrowRightIcon size={13} strokeWidth={2} />
        </a>
      </div>
    </section>
  );
}

function TokenFace({ token }: { token: AmmoraTokenView }) {
  const [failed, setFailed] = useState(false);
  const image = !failed && token.image ? token.image : '';
  return (
    <span className="relative h-[36px] w-[36px] shrink-0">
      {image ? (
        <img
          src={image}
          alt=""
          width={36}
          height={36}
          className="h-[36px] w-[36px] rounded-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="flex h-[36px] w-[36px] items-center justify-center rounded-full font-sans text-[14px] font-bold text-[#14120a]"
          style={{ background: avatarColor(token.address) }}
          aria-hidden
        >
          {token.symbol.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="absolute -bottom-[2px] -right-[2px] flex h-[14px] w-[14px] items-center justify-center rounded-full border-2 border-[#101012] bg-[#6e2c72] font-sans text-[8px] font-bold text-white">
        A
      </span>
    </span>
  );
}

function LaunchRow({ token }: { token: AmmoraTokenView }) {
  const phase = launchPhase(token);
  const phaseLabel = phase === 'active' ? 'Active' : phase === 'upcoming' ? 'Upcoming' : 'Not tradable';
  const phaseClass =
    phase === 'active'
      ? 'bg-[#10281a] text-[#3ddc84]'
      : phase === 'upcoming'
        ? 'bg-[#2a1833] text-[#e2c0f5]'
        : 'bg-[#1c1c1f] text-[#b0b0b6]';
  return (
    <li className="flex min-w-0 items-center gap-[8px] rounded-[14px] border border-[#26262a] bg-[#101012] px-[10px] py-[10px]">
      <TokenFace token={token} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-[6px]">
          <span className="truncate font-sans text-[13px] font-semibold text-white">{token.symbol}</span>
          <span className={`shrink-0 rounded-full px-[6px] py-[1px] font-sans text-[9px] font-medium ${phaseClass}`}>{phaseLabel}</span>
        </span>
        <span className="mt-[1px] block truncate font-sans text-[11px] text-[#b5b5ba]">{token.name || 'Ammora launch'}</span>
        <span className="mt-[1px] flex items-center gap-[4px] font-mono text-[10px] text-[#8d8d93]">
          {short(token.address)}
          <CopyAddress address={token.address} />
        </span>
      </span>
      <span className="flex min-w-0 max-w-[64%] flex-wrap items-center justify-end gap-x-[6px] gap-y-[4px]">
        <span className="w-[40px] text-right">
          <span className="block font-sans text-[11px] font-semibold text-white">
            <span className="sr-only">Price unavailable</span>
            <span aria-hidden>--</span>
          </span>
          <span className="block font-sans text-[10px] text-[#8d8d93]">
            <span className="sr-only">Change unavailable</span>
            <span aria-hidden>--</span>
          </span>
        </span>
        <FlatSpark />
        <span className="w-[46px] text-right">
          <span className="block font-sans text-[11px] font-semibold text-white">
            <span className="sr-only">Market cap unavailable</span>
            <span aria-hidden>--</span>
          </span>
          <span className="block font-sans text-[8px] leading-[10px] text-[#8d8d93]">Market cap</span>
        </span>
        {token.tradable ? (
          <Link
            href={`/dashboard/explore/tokens/${token.address}`}
            aria-label={`Trade ${token.label}`}
            className="btn-sun hit-y-44 h-[30px] gap-[4px] rounded-[8px] px-[10px] font-sans text-[11px] font-semibold no-underline"
          >
            Trade
          </Link>
        ) : (
          <span className="inline-flex h-[30px] items-center rounded-[8px] border border-[#2a2b30] bg-[#1a1a1d] px-[8px] font-sans text-[10px] text-[#9a9aa0]">
            Not tradable yet
          </span>
        )}
      </span>
    </li>
  );
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : `Copy ${address}`}
      onClick={() => {
        navigator.clipboard.writeText(address).then(
          () => setCopied(true),
          () => {}
        );
      }}
      className="text-[#bdbdbd]"
    >
      {copied ? <CopiedMark /> : <CopyIcon size={11} />}
    </button>
  );
}

function FlatSpark() {
  return (
    <svg width="32" height="18" viewBox="0 0 32 18" className="shrink-0" aria-hidden>
      <path d="M0 9 H32" stroke="#5c5c60" strokeWidth="1.2" strokeDasharray="2 2" />
    </svg>
  );
}

function SortIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M4 3.2v7.6M4 3.2L2.2 5M4 3.2L5.8 5M10 10.8V3.2M10 10.8L8.2 9M10 10.8l1.8-1.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function Caret() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path d="M2.2 3.8L5 6.6l2.8-2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CopiedMark() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
      <path d="M2 5.6l2.3 2.3L9 3.2" stroke="#3ddc84" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
