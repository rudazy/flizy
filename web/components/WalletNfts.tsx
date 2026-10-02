'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppCard as Card, AppCardHeader as CardHeader } from './AppCard';
import { ArrowRightIcon, CheckIcon, ChevronRightIcon, NftsIcon } from './ExploreIcons';
import { NftArt } from './NftCollection';
import { ethFromWei } from '../lib/nftFormat';

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

const COLLAPSED = 4;
/** Same mask as the balances above, for listed prices and held counts. */
const HIDDEN = '••••';

/**
 * Every NFT in the wallet, from any collection, not only the verified ones.
 * Each opens its page on the marketplace. Verified ones carry the gold check
 * and can be sent in chat; the rest say they cannot.
 */
export function WalletNfts({ chainName, hidden }: { chainName: string; hidden: boolean }) {
  const [nfts, setNfts] = useState<WalletNft[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

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

  const shown = expanded ? nfts ?? [] : (nfts ?? []).slice(0, COLLAPSED);
  const more = (nfts?.length ?? 0) > COLLAPSED || next != null;

  return (
    <Card className="px-[9.8px] pb-[9.5px] pt-[10.5px]">
      <CardHeader
        icon={<NftsIcon size={15} />}
        title="NFTs"
        subtitle={`Your NFTs on ${chainName}.`}
        action={
          more ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              className="hit-y-44 flex h-[28px] items-center gap-[14px] rounded-[4px] border border-[#3a3b40] bg-[#0f0f10] px-[10px] font-sans text-[9.6px] text-[#ececec] hover:text-white"
            >
              {expanded ? 'Show less' : 'View all'}
              <ArrowRightIcon size={12} strokeWidth={1.8} className={expanded ? '-rotate-90' : ''} />
            </button>
          ) : null
        }
      />
      <ul className="m-0 mt-[11px] grid list-none gap-[5px] p-0">
        {error ? (
          <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">{error}</li>
        ) : null}
        {!nfts && !error ? (
          <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">Loading...</li>
        ) : null}
        {nfts && nfts.length === 0 ? (
          <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">
            NFTs appear here after you mint, buy or receive them.
          </li>
        ) : null}
        {shown.map((n) => (
          <li key={`${n.collection}:${n.tokenId}`}>
            <Link
              href={`/dashboard/explore/nfts/${n.collection}/${n.tokenId}`}
              className="flex h-[53.5px] items-center gap-[12px] rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] pl-[7px] pr-[12px] no-underline"
            >
              <NftArt src={n.image} alt="" initial={n.collectionName} className="h-[45px] w-[45px] shrink-0 rounded-[4px]" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-[5px] font-sans text-[11.5px] font-medium text-white">
                  <span className="truncate">{n.name}</span>
                  {n.verified ? (
                    <span className="inline-flex h-[11px] w-[11px] shrink-0 items-center justify-center rounded-full bg-sun text-[#1a1405]" title="Verified by Flizy">
                      <CheckIcon size={7} strokeWidth={3.2} />
                    </span>
                  ) : null}
                </span>
                <span className="block truncate font-sans text-[9.3px] text-[#a9a9a9]">
                  {n.listedWei
                    ? `Listed for ${hidden ? HIDDEN : ethFromWei(n.listedWei)} ETH`
                    : n.sendableInChat
                      ? n.collectionName
                      : n.standard === 'ERC-1155'
                        ? `${n.collectionName} · ${hidden ? HIDDEN : n.amount} held · not sendable in chat`
                        : `${n.collectionName} · can't be sent in chat`}
                </span>
              </span>
              <ChevronRightIcon size={13} className="shrink-0 text-[#cfcfcf]" />
            </Link>
          </li>
        ))}
        {expanded && next ? (
          <li>
            <button type="button" onClick={() => load(next)} className="h-[36px] w-full rounded-[5px] border border-[#1f1f22] font-sans text-[10px] text-[#ececec]">
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
    </Card>
  );
}
