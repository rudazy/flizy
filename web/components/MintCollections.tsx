'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { NftArt } from './NftCollection';
import { MintStatusPill, type MintDrop } from './MintPanel';
import { ShieldCheckIcon } from './ExploreIcons';
import { isLiveStatus } from '../lib/mintFormat';
import { artworkFor } from '../lib/nftArtwork';

type Listed = { ticker: string; address: string; name: string; items: number | null; owners: number | null };

type Row = {
  address: string;
  name: string;
  imageUrl: string | null;
  verified: boolean;
  items: number | null;
  drop: MintDrop | null;
};

/**
 * Explore -> NFTs -> Collections: every collection on Flizy, the ones Flizy
 * lists and every one launched or brought here to mint, each marked Verified
 * or Not verified. A collection still minting opens on its mint.
 */
export function MintCollections() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [listedRes, dropsRes] = await Promise.all([fetch('/api/nfts'), fetch('/api/mints?status=all')]);
        const listed = await listedRes.json().catch(() => ({}));
        const drops = await dropsRes.json().catch(() => ({}));
        if (cancelled) return;
        if (!listedRes.ok && !dropsRes.ok) {
          setError('Could not load collections.');
          return;
        }
        const byAddress = new Map<string, Row>();
        for (const c of (Array.isArray(listed.collections) ? listed.collections : []) as Listed[]) {
          byAddress.set(c.address.toLowerCase(), {
            address: c.address,
            name: c.name,
            imageUrl: artworkFor(null, c.ticker),
            verified: true,
            items: c.items,
            drop: null,
          });
        }
        for (const d of (Array.isArray(drops.drops) ? drops.drops : []) as MintDrop[]) {
          const key = d.collection.toLowerCase();
          const existing = byAddress.get(key);
          byAddress.set(key, {
            address: d.collection,
            name: existing?.name ?? d.name,
            imageUrl: existing?.imageUrl ?? artworkFor(d.imageUrl, d.ticker),
            verified: d.verified,
            items: existing?.items ?? d.minted,
            drop: d,
          });
        }
        setRows([...byAddress.values()].sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name)));
      } catch {
        if (!cancelled) setError('Could not load collections.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <p className="alert alert-error m-0">{error}</p>;
  if (!rows) return <p className="m-0 font-sans text-[11px] text-[#a9a9a9]">Loading...</p>;
  if (rows.length === 0) return <p className="m-0 font-sans text-[11px] text-[#a9a9a9]">No collections on Flizy yet.</p>;

  return (
    <div className="grid gap-[8px]">
      {rows.map((r) => {
        const minting = r.drop != null && (isLiveStatus(r.drop.status) || r.drop.status === 'upcoming');
        return (
          <Link
            key={r.address}
            href={minting ? `/dashboard/explore/nfts/mint/${r.address}` : `/dashboard/explore/nfts/${r.address}`}
            className="flex items-center gap-[12px] rounded-[8px] border border-[#23242a] bg-[#0d0d0e] p-[10px] no-underline hover:border-[#3a3b40]"
          >
            <NftArt src={r.imageUrl} alt={`${r.name} artwork`} initial={r.name} className="h-[48px] w-[48px] shrink-0 rounded-[6px]" />
            <span className="grid min-w-0 flex-1 gap-[3px]">
              <span className="flex items-center gap-[5px]">
                <span className="truncate font-sans text-[13px] font-semibold text-white">{r.name}</span>
                {r.verified ? <ShieldCheckIcon size={12} className="shrink-0 text-sun" /> : null}
              </span>
              <span className="font-sans text-[10.5px] text-[#a9a9a9]">
                {r.verified ? 'Verified' : 'Not verified'}
                {r.items != null ? ` · ${r.items.toLocaleString('en-US')} items` : ''}
              </span>
            </span>
            {r.drop ? <MintStatusPill status={r.drop.status} contractManaged={r.drop.contractManaged} /> : null}
          </Link>
        );
      })}
    </div>
  );
}
