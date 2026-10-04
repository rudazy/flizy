'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { NftArt } from './NftCollection';
import { artworkFor } from '../lib/nftArtwork';
import { MintStatusPill, type MintDrop } from './MintPanel';
import { ChevronRightIcon, EthDiamondIcon, PlusIcon, ShieldCheckIcon } from './ExploreIcons';
import { ethFromWei, usdLabel } from '../lib/nftFormat';
import { countdown, isLiveStatus } from '../lib/mintFormat';

const FILTERS = [
  { id: 'live', label: 'Live' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'allowlist', label: 'Allowlist' },
  { id: 'ending', label: 'Ending soon' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

const EMPTY: Record<FilterId, string> = {
  live: 'Nothing is minting right now.',
  upcoming: 'No mints are scheduled yet.',
  allowlist: 'No allowlist mints are running or coming up.',
  ending: 'No live mint ends in the next 24 hours.',
};

/**
 * Explore -> NFTs -> Mint: drops that mint through Flizy, Flizy-managed and
 * Contract-managed, filtered by Live, Upcoming, Allowlist and Ending soon,
 * plus the way in for creators.
 */
export function MintList() {
  const [filter, setFilter] = useState<FilterId>('live');
  const [drops, setDrops] = useState<MintDrop[] | null>(null);
  const [usd, setUsd] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;
    setDrops(null);
    setError('');
    (async () => {
      try {
        const res = await fetch(`/api/mints?status=${filter}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error || 'Could not load mints.');
        else {
          setDrops(Array.isArray(body.drops) ? body.drops : []);
          setUsd(typeof body.usdPerEth === 'number' ? body.usdPerEth : null);
        }
      } catch {
        if (!cancelled) setError('Could not load mints.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="grid gap-[12px]">
      <section className="relative overflow-hidden rounded-[6px] border border-[#5a4a1c] p-[14px]" style={{ background: 'linear-gradient(135deg, #1a160c 0%, #14120b 45%, #100f0b 100%)' }}>
        <h2 className="m-0 font-sans text-[14px] font-bold text-white">Launching an NFT collection?</h2>
        <p className="m-0 mt-[4px] font-sans text-[11px] leading-[15px] text-[#c9c9c9]">
          Create a new collection on Flizy, or bring the one you already have, and let your community mint it here.
        </p>
        <div className="mt-[10px] flex flex-wrap gap-[8px]">
          <Link href="/dashboard/explore/nfts/create" className="btn-sun hit-y-44 inline-flex h-[30px] items-center gap-[6px] rounded-[5px] px-[12px] font-sans text-[11px] font-semibold no-underline">
            <PlusIcon size={12} /> Create a Mint
          </Link>
          <Link href="/dashboard/explore/nfts/mints" className="hit-y-44 inline-flex h-[30px] items-center gap-[6px] rounded-[5px] border border-[#3a3b40] px-[12px] font-sans text-[11px] text-[#ececec] no-underline hover:border-sun">
            My Mints <ChevronRightIcon size={11} />
          </Link>
        </div>
      </section>

      <div className="flex gap-[6px] overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Mint filter">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`hit-y-44 h-[28px] shrink-0 rounded-full border px-[12px] font-sans text-[11px] ${
              filter === f.id ? 'border-sun text-sun' : 'border-[#2a2b30] text-[#cfcfcf] hover:text-white'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? <p className="alert alert-error m-0">{error}</p> : null}
      {drops === null && !error ? <p className="m-0 font-sans text-[11px] text-[#a9a9a9]">Loading...</p> : null}
      {drops && drops.length === 0 ? <p className="m-0 font-sans text-[11px] text-[#a9a9a9]">{EMPTY[filter]}</p> : null}
      {drops && drops.length > 0 ? (
        <div className="grid gap-[10px]">
          {drops.map((d) => (
            <MintCard key={d.collection} drop={d} usdPerEth={usd} now={now} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MintCard({ drop: d, usdPerEth, now }: { drop: MintDrop; usdPerEth: number | null; now: number }) {
  const pct = d.maxSupply ? Math.min(100, (d.minted / d.maxSupply) * 100) : 0;
  const free = d.priceWei === '0';
  const c = d.config;
  const live = isLiveStatus(d.status);
  const timing =
    d.status === 'upcoming' && d.nextChangeAt
      ? `Starts in ${countdown(d.nextChangeAt, now)}`
      : live && c?.mintEnd
        ? `Ends in ${countdown(c.mintEnd, now)}`
        : null;
  return (
    <Link
      href={`/dashboard/explore/nfts/mint/${d.collection}`}
      className="grid grid-cols-[76px_minmax(0,1fr)] gap-[12px] rounded-[8px] border border-[#23242a] bg-[#0d0d0e] p-[10px] no-underline hover:border-[#3a3b40]"
    >
      <NftArt src={artworkFor(d.imageUrl, d.ticker)} alt={`${d.name} artwork`} initial={d.name} className="h-[76px] w-[76px] rounded-[6px]" />
      <div className="grid min-w-0 gap-[5px]">
        <div className="flex items-center justify-between gap-[8px]">
          <span className="flex min-w-0 items-center gap-[5px]">
            <span className="truncate font-sans text-[13px] font-semibold text-white">{d.name}</span>
            {d.verified ? <ShieldCheckIcon size={12} className="shrink-0 text-sun" aria-label="Verified by Flizy" /> : null}
          </span>
          <MintStatusPill status={d.status} contractManaged={d.contractManaged} />
        </div>
        <span className="inline-flex items-center gap-[5px] font-sans text-[12px] text-white">
          <EthDiamondIcon size={11} className="text-[#cfcfcf]" />
          {d.priceWei == null ? 'Price set by the contract' : free ? 'Free mint' : `${ethFromWei(d.priceWei)} ETH`}
          {!free && d.priceWei && usdLabel(d.priceWei, usdPerEth) ? (
            <span className="text-[10.5px] text-[#8d8d8d]">{usdLabel(d.priceWei, usdPerEth)}</span>
          ) : null}
        </span>
        {d.maxSupply ? (
          <div className="h-[4px] overflow-hidden rounded-full bg-[#1d1e22]" aria-hidden>
            <div className="h-full rounded-full bg-sun" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        <span className="flex items-center justify-between gap-[8px] font-sans text-[10.5px] text-[#a9a9a9]">
          <span>
            {d.minted.toLocaleString('en-US')}
            {d.maxSupply ? ` / ${d.maxSupply.toLocaleString('en-US')}` : ''} minted
            {d.contractManaged ? ' · Contract-managed' : ''}
            {!d.verified ? ' · Not verified' : ''}
          </span>
          {timing ? <span className="shrink-0">{timing}</span> : null}
        </span>
      </div>
    </Link>
  );
}
