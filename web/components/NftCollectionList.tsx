'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeftIcon, CheckIcon, SearchIcon } from './ExploreIcons';
import { NftArt } from './NftCollection';
import { compactCount, ethFromWei } from '../lib/nftFormat';

type Row = {
  address: string;
  name: string;
  standard: string;
  holders: number | null;
  supply: string | null;
  verified: boolean;
  avatar: string | null;
  floorWei: string | null;
  volumeWei: string;
};

/**
 * Every NFT collection on the network, searchable. Verified ones carry the
 * gold check; collections with marketplace activity come first.
 */
export function NftCollectionList() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async (cursor: string | null) => {
      const params = new URLSearchParams();
      if (debounced) params.set('q', debounced);
      if (cursor) params.set('cursor', cursor);
      try {
        const res = await fetch(`/api/nfts/collections?${params.toString()}`);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load collections.');
        setRows((prev) => (cursor && prev ? [...prev, ...body.collections] : body.collections));
        setNext(body.next);
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load collections.');
      }
    },
    [debounced]
  );

  useEffect(() => {
    setRows(null);
    load(null);
  }, [load]);

  return (
    <div className="-mt-4 w-full min-w-0 pb-[calc(var(--app-nav-clearance)+16px)] md:pb-16">
      <header className="sticky top-0 z-40 -mx-4 flex h-[60px] items-center gap-[10px] bg-ink/90 px-4 backdrop-blur-md sm:-mx-6 sm:px-6">
        <Link href="/dashboard/explore?s=nfts" aria-label="Back to NFTs" className="hit-44 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-[#141416] text-white no-underline">
          <ArrowLeftIcon size={19} />
        </Link>
        <h1 className="m-0 font-sans text-[17px] font-semibold text-white">All collections</h1>
      </header>

      <label className="mt-[6px] flex h-[42px] items-center gap-[8px] rounded-[10px] border border-[#2a2b30] bg-[#0d0d0e] px-[12px]">
        <SearchIcon size={16} className="shrink-0 text-[#9a9a9a]" />
        <span className="sr-only">Search collections</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search collections on GIWA..."
          className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-white outline-none placeholder:text-[#7d7d7d]"
        />
      </label>
      <p className="m-0 mt-[8px] font-sans text-[11.5px] leading-[16px] text-[#8d8d8d]">
        Anyone can deploy a collection with any name. The gold check means Flizy verified the contract; only those can be sent in chat.
      </p>

      {error ? <p className="alert alert-error m-0 mt-[12px]">{error}</p> : null}
      {!rows && !error ? <p className="m-0 mt-[12px] font-sans text-[12px] text-[#a9a9a9]">Loading...</p> : null}
      {rows && rows.length === 0 ? <p className="m-0 mt-[12px] font-sans text-[12.5px] text-[#a9a9a9]">No collections match.</p> : null}

      <ul className="m-0 mt-[10px] list-none p-0">
        {(rows ?? []).map((r) => (
          <li key={r.address}>
            <Link href={`/dashboard/explore/nfts/${r.address}`} className="flex items-center gap-[12px] border-b border-[#1b1c20] py-[11px] no-underline">
              <NftArt src={r.avatar} alt="" initial={r.name} className="h-[46px] w-[46px] shrink-0 rounded-[10px]" />
              <div className="min-w-0 flex-1">
                <p className="m-0 flex items-center gap-[6px] font-sans text-[14px] font-medium text-white">
                  <span className="truncate">{r.name}</span>
                  {r.verified ? (
                    <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full bg-sun text-[#1a1405]" title="Verified by Flizy">
                      <CheckIcon size={9} strokeWidth={3} />
                    </span>
                  ) : null}
                </p>
                <p className="m-0 mt-[2px] font-sans text-[11.5px] text-[#9a9a9a]">
                  {r.standard} · {compactCount(r.holders)} owners
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="m-0 font-sans text-[12.5px] text-white">{r.floorWei ? `${ethFromWei(r.floorWei)} ETH` : '-'}</p>
                <p className="m-0 mt-[2px] font-sans text-[11px] text-[#8d8d8d]">Floor</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {next ? (
        <button type="button" onClick={() => load(next)} className="mt-[12px] h-[40px] w-full rounded-[9px] border border-[#2a2b30] font-sans text-[12.5px] text-white">
          Load more
        </button>
      ) : null}
    </div>
  );
}
