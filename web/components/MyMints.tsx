'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { NftArt } from './NftCollection';
import { artworkFor } from '../lib/nftArtwork';
import { MintStatusPill, type MintDrop } from './MintPanel';
import { PlusIcon } from './ExploreIcons';
import { ethFromWei } from '../lib/nftFormat';

type Stats = { revenueWei: string; feesWei: string; mintedViaFlizy: number; mintsToday: number };
type MyDrop = MintDrop & { stats: Stats | null };

/** My Mints: every drop this account launched, with what it has earned. */
export function MyMints() {
  const [drops, setDrops] = useState<MyDrop[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/mints/mine');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error || 'Could not load your mints.');
        else setDrops(Array.isArray(body.drops) ? body.drops : []);
      } catch {
        if (!cancelled) setError('Could not load your mints.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="grid w-full gap-[14px] pt-[6px]">
      <div className="flex items-center justify-between">
        <Link href="/dashboard/explore?s=nfts&nft=mint" className="hit-y-44 font-sans text-[12.5px] text-[#cfcfcf] no-underline hover:text-white">
          Back to Mint
        </Link>
        <Link href="/dashboard/explore/nfts/create" className="btn-sun hit-y-44 inline-flex h-[30px] items-center gap-[6px] rounded-[5px] px-[12px] font-sans text-[11px] font-semibold no-underline">
          <PlusIcon size={12} /> Create a Mint
        </Link>
      </div>
      <h1 className="m-0 font-sans text-[20px] font-bold text-white">My Mints</h1>
      {error ? <p className="alert alert-error m-0">{error}</p> : null}
      {drops === null && !error ? <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">Loading...</p> : null}
      {drops && drops.length === 0 ? (
        <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">You have not launched a mint yet.</p>
      ) : null}
      {drops?.map((d) => (
        <article key={d.collection} className="grid gap-[10px] rounded-[10px] border border-[#23242a] bg-[#0d0d0e] p-[12px]">
          <div className="flex items-center gap-[12px]">
            <NftArt src={artworkFor(d.imageUrl, d.ticker)} alt={`${d.name} artwork`} initial={d.name} className="h-[52px] w-[52px] shrink-0 rounded-[8px]" />
            <div className="grid min-w-0 flex-1 gap-[4px]">
              <span className="truncate font-sans text-[14px] font-semibold text-white">{d.name}</span>
              <span className="font-sans text-[11.5px] text-[#a9a9a9]">
                {d.minted.toLocaleString('en-US')}
                {d.maxSupply ? ` / ${d.maxSupply.toLocaleString('en-US')}` : ''} minted
                {d.priceWei != null ? ` · ${d.priceWei === '0' ? 'Free mint' : `${ethFromWei(d.priceWei)} ETH`}` : ''}
              </span>
            </div>
            <MintStatusPill status={d.status} contractManaged={d.contractManaged} />
          </div>
          {d.stats ? (
            <div className="grid grid-cols-2 gap-[8px] font-sans text-[11.5px]">
              <span className="text-[#a9a9a9]">
                Revenue <span className="text-white">{ethFromWei(d.stats.revenueWei)} ETH</span>
              </span>
              <span className="text-[#a9a9a9]">
                Mints today <span className="text-white">{d.stats.mintsToday}</span>
              </span>
            </div>
          ) : null}
          <Link
            href={d.contractManaged ? `/dashboard/explore/nfts/mint/${d.collection}` : `/dashboard/explore/nfts/mints/${d.collection}`}
            className="hit-y-44 inline-flex h-[34px] items-center justify-center rounded-[6px] border border-[#3a3b40] font-sans text-[12.5px] text-white no-underline hover:border-sun"
          >
            {d.contractManaged ? 'View mint' : d.status === 'unconfigured' ? 'Set up the mint' : 'Manage'}
          </Link>
        </article>
      ))}
    </div>
  );
}
