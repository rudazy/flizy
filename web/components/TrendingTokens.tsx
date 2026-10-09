'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { EthDiamondIcon, FlameIcon, ChevronRightIcon } from './ExploreIcons';
import { formatEthDisplay } from '../lib/tokenFormat';
import type { DiscoveryToken } from '../lib/tokenDiscovery';
import { tokenLogo } from '../lib/tokenLogos';

/**
 * Trending tokens on Home: the listed tokens and their last-hour move, read
 * from the same /api/tokens the Explore token list uses.
 *
 * Only tokens Flizy lists are shown; a listed token opens by its contract.
 * ETH is priced in FLZ from the same pool, because in ETH it would always
 * read 1; its move is the inverse of FLZ's. The chips slide past on their own
 * (token-marquee in globals.css) unless the device asks for reduced motion.
 */

type Chip = { symbol: string; price: string; unit: string; change: number | null; href: string };

/** Below this many chips one set can be narrower than the card, so the loop doubles it. */
const LOOP_MIN_CHIPS = 8;

function chipsFrom(tokens: DiscoveryToken[]): Chip[] {
  const chips: Chip[] = [];
  const flz = tokens.find((t) => t.symbol.toUpperCase() === 'FLZ');
  for (const t of tokens) {
    const price = formatEthDisplay(t.priceEth, 6);
    chips.push({
      symbol: t.symbol.toUpperCase(),
      price: price ?? '-',
      unit: price ? 'ETH' : '',
      change: t.change1hPct,
      href: `/dashboard/explore/tokens/${t.address || t.symbol.toLowerCase()}`,
    });
    if (t === flz) {
      const per = Number(flz.flzPerEth);
      const change =
        flz.change1hPct != null && Number.isFinite(flz.change1hPct) && flz.change1hPct > -100
          ? 100 / (1 + flz.change1hPct / 100) - 100
          : null;
      chips.push({
        symbol: 'ETH',
        price: Number.isFinite(per) && per > 0 ? per.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '-',
        unit: Number.isFinite(per) && per > 0 ? 'FLZ' : '',
        change,
        href: '/dashboard/swap?from=ETH&to=FLZ',
      });
    }
  }
  return chips;
}

function Mark({ symbol }: { symbol: string }) {
  // Symbols here come from /api/tokens, Flizy's own list.
  const src = tokenLogo(symbol);
  if (src) {
    return <img src={src} alt="" width={22} height={22} className="h-[22px] w-[22px] shrink-0 rounded-full object-cover" />;
  }
  if (symbol === 'ETH') {
    return (
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#161616] text-[#e6e6e6]" aria-hidden>
        <EthDiamondIcon size={12} />
      </span>
    );
  }
  return (
    <span
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-sun/50 bg-[#0b0b0b] font-sans text-[11px] font-bold text-sun"
      aria-hidden
    >
      {symbol.slice(0, 1)}
    </span>
  );
}

function ChipLink({ chip: c, copy }: { chip: Chip; copy: boolean }) {
  return (
    <Link
      href={c.href}
      // The second copy only exists for the loop: hidden from screen readers and tabbing.
      tabIndex={copy ? -1 : undefined}
      aria-hidden={copy || undefined}
      className="flex min-w-[72px] shrink-0 items-start gap-[5px] rounded-[5px] border border-[#232326] bg-[#111113] px-[6px] py-[6px] no-underline hover:border-sun/40"
    >
      <Mark symbol={c.symbol} />
      <span className="grid min-w-0 gap-[1px]">
        <span className="font-sans text-[10.5px] font-semibold leading-tight text-white">{c.symbol}</span>
        <span className="truncate font-mono text-[8.5px] leading-tight text-[#bdbdbd]">
          {c.price}
          {c.unit ? ` ${c.unit}` : ''}
        </span>
        <span
          className={`font-mono text-[8.5px] leading-tight ${
            c.change == null ? 'text-[#8d8d8d]' : c.change >= 0 ? 'text-[#2fd27a]' : 'text-[#f05252]'
          }`}
        >
          {c.change == null ? 'No trades 1h' : `${c.change >= 0 ? '+' : ''}${c.change.toFixed(2)}%`}
        </span>
      </span>
    </Link>
  );
}

export function TrendingTokens() {
  const [chips, setChips] = useState<Chip[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/tokens')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (live) setChips(res.ok && Array.isArray(body.tokens) ? chipsFrom(body.tokens as DiscoveryToken[]) : []);
      })
      .catch(() => live && setChips([]));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="col-span-2 flex min-w-0 flex-col rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[8px] pb-[8px] pt-[7px]" aria-label="Trending tokens">
      <Link
        href="/dashboard/explore?s=tokens"
        className="flex items-center gap-[6px] px-[1px] font-sans text-[11px] text-white no-underline hover:text-sun"
      >
        <FlameIcon size={12} className="text-sun" />
        <span className="flex-1">Trending tokens</span>
        <ChevronRightIcon size={12} className="text-[#8d8d8d]" />
      </Link>
      <div className="mt-[6px] flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {chips === null ? (
          <div className="flex gap-[5px]">
            {[0, 1].map((i) => (
              <span key={i} className="h-[46px] w-[72px] shrink-0 animate-pulse rounded-[5px] bg-[#151517]" aria-hidden />
            ))}
          </div>
        ) : chips.length === 0 ? (
          <p className="m-0 self-center font-sans text-[10px] text-[#8d8d8d]">No listed token has a pool yet.</p>
        ) : (
          <div className="token-marquee flex w-max">
            <div className="flex gap-[5px] pr-[5px]">
              {chips.map((c) => (
                <ChipLink key={c.symbol} chip={c} copy={false} />
              ))}
              {/* A short list repeats so each half of the track is wider than the card. */}
              {chips.length < LOOP_MIN_CHIPS
                ? chips.map((c) => <ChipLink key={`again-${c.symbol}`} chip={c} copy />)
                : null}
            </div>
            <div className="token-marquee-copy flex gap-[5px] pr-[5px]" aria-hidden>
              {[...chips, ...(chips.length < LOOP_MIN_CHIPS ? chips : [])].map((c, i) => (
                <ChipLink key={`copy-${i}`} chip={c} copy />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
