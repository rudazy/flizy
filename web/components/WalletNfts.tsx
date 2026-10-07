'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppCollapsibleCard } from './AppCard';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, NftsIcon } from './ExploreIcons';
import { NftArt } from './NftCollection';
import { ethFromWei, groupByCollection } from '../lib/nftFormat';

type WalletNft = {
  collection: string;
  collectionName: string;
  standard: string;
  tokenId: string;
  name: string;
  image: string | null;
  amount: string;
  verified: boolean;
  sendableInChat: boolean;
  listedWei: string | null;
};

type Group = { collection: string; name: string; verified: boolean; image: string | null; items: WalletNft[] };

/** Same mask as the balances above, for listed prices and held counts. */
const HIDDEN = '••••';

const ROW =
  'flex h-[53.5px] w-full items-center gap-[12px] rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] pl-[7px] pr-[12px] text-left no-underline';

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Every NFT in the wallet, from any collection, not only the verified ones.
 * The card opens on tap. Inside, a collection the wallet holds more than once
 * is its own row that opens on tap. Each NFT opens its page on the
 * marketplace. Verified ones carry the gold check and can be sent in chat; the
 * rest say they cannot.
 */
export function WalletNfts({ chainName, hidden }: { chainName: string; hidden: boolean }) {
  const [nfts, setNfts] = useState<WalletNft[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());

  const load = useCallback(async (cursor: string | null) => {
    try {
      const res = await fetch(`/api/nfts/mine${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load your NFTs.');
      setNfts((prev) => (cursor && prev ? [...prev, ...body.nfts] : body.nfts));
      setNext(body.next);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your NFTs.');
    }
  }, []);

  useEffect(() => {
    load(null);
  }, [load]);

  const groups = useMemo<Group[]>(
    () =>
      groupByCollection(nfts ?? []).map(({ collection, items }) => ({
        collection,
        name: items[0].collectionName,
        verified: items[0].verified,
        image: items.find((n) => n.image)?.image ?? null,
        items,
      })),
    [nfts]
  );

  // The count is a holding, so the eye covers it like any other amount.
  const subtitle =
    nfts && !error && !hidden
      ? nfts.length
        ? `${nfts.length}${next ? '+' : ''} ${nfts.length === 1 && !next ? 'NFT' : 'NFTs'} in ${count(groups.length, 'collection', 'collections')} on ${chainName}.`
        : `No NFTs on ${chainName} yet.`
      : `Your NFTs on ${chainName}.`;

  function toggleGroup(collection: string) {
    setOpenGroups((prev) => {
      const nextOpen = new Set(prev);
      if (nextOpen.has(collection)) nextOpen.delete(collection);
      else nextOpen.add(collection);
      return nextOpen;
    });
  }

  return (
    <AppCollapsibleCard
      id="wallet-nfts"
      icon={<NftsIcon size={15} />}
      title="NFTs"
      subtitle={subtitle}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    >
      <ul className="m-0 mt-[11px] grid list-none gap-[5px] p-0">
        {error ? <Note>{error}</Note> : null}
        {!nfts && !error ? <Note>Loading...</Note> : null}
        {nfts && nfts.length === 0 && !error ? <Note>NFTs appear here after you mint, buy or receive them.</Note> : null}
        {groups.map((g) => {
          if (g.items.length === 1) return <NftRow key={g.collection} n={g.items[0]} hidden={hidden} />;
          const isOpen = openGroups.has(g.collection);
          const listed = g.items.filter((n) => n.listedWei).length;
          const panel = `wallet-nfts-${g.collection.toLowerCase()}`;
          return (
            <li key={g.collection}>
              <button
                type="button"
                onClick={() => toggleGroup(g.collection)}
                aria-expanded={isOpen}
                aria-controls={panel}
                className={ROW}
              >
                <NftArt src={g.image} alt="" initial={g.name} className="h-[45px] w-[45px] shrink-0 rounded-[4px]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-[5px] font-sans text-[11.5px] font-medium text-white">
                    <span className="truncate">{g.name}</span>
                    {g.verified ? <VerifiedCheck /> : null}
                  </span>
                  <span className="block truncate font-sans text-[9.3px] text-[#a9a9a9]">
                    {hidden ? HIDDEN : g.items.length} NFTs{listed && !hidden ? ` · ${listed} listed` : ''}
                  </span>
                </span>
                <ChevronDownIcon
                  size={13}
                  className={`shrink-0 text-[#cfcfcf] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {isOpen ? (
                <ul id={panel} className="m-0 ml-[29px] mt-[5px] grid list-none gap-[5px] border-l border-[#2a2b30] p-0 pl-[9px]">
                  {g.items.map((n) => (
                    <NftRow key={`${n.collection}:${n.tokenId}`} n={n} hidden={hidden} inGroup />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
        {next ? (
          <li>
            <button
              type="button"
              onClick={() => load(next)}
              className="h-[36px] w-full rounded-[5px] border border-[#1f1f22] font-sans text-[10px] text-[#ececec]"
            >
              Load more
            </button>
          </li>
        ) : null}
      </ul>
      <Link
        href="/dashboard/explore/nfts/me"
        className="mt-[8px] flex h-[32px] items-center justify-center rounded-[5px] border border-[#1f1f22] font-sans text-[9.6px] text-[#ececec] no-underline hover:text-white"
      >
        My NFTs and offers
      </Link>
    </AppCollapsibleCard>
  );
}

function Note({ children }: { children: string }) {
  return (
    <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">
      {children}
    </li>
  );
}

function VerifiedCheck() {
  return (
    <span className="inline-flex h-[11px] w-[11px] shrink-0 items-center justify-center rounded-full bg-sun text-[#1a1405]" title="Verified by Flizy">
      <CheckIcon size={7} strokeWidth={3.2} />
    </span>
  );
}

/** One NFT. Inside its collection's group the collection name is already above it, so the line leaves it out. */
function NftRow({ n, hidden, inGroup = false }: { n: WalletNft; hidden: boolean; inGroup?: boolean }) {
  const line = n.listedWei
    ? `Listed for ${hidden ? HIDDEN : ethFromWei(n.listedWei)} ETH`
    : inGroup
      ? n.sendableInChat
        ? 'Can be sent in chat'
        : n.standard === 'ERC-1155'
          ? `${hidden ? HIDDEN : n.amount} held · not sendable in chat`
          : "Can't be sent in chat"
      : n.sendableInChat
        ? n.collectionName
        : n.standard === 'ERC-1155'
          ? `${n.collectionName} · ${hidden ? HIDDEN : n.amount} held · not sendable in chat`
          : `${n.collectionName} · can't be sent in chat`;
  return (
    <li>
      <Link href={`/dashboard/explore/nfts/${n.collection}/${n.tokenId}`} className={ROW}>
        <NftArt src={n.image} alt="" initial={n.collectionName} className="h-[45px] w-[45px] shrink-0 rounded-[4px]" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-[5px] font-sans text-[11.5px] font-medium text-white">
            <span className="truncate">{n.name}</span>
            {n.verified ? <VerifiedCheck /> : null}
          </span>
          <span className="block truncate font-sans text-[9.3px] text-[#a9a9a9]">{line}</span>
        </span>
        <ChevronRightIcon size={13} className="shrink-0 text-[#cfcfcf]" />
      </Link>
    </li>
  );
}
