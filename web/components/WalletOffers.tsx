'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppCollapsibleCard } from './AppCard';
import { ChevronDownIcon, TagIcon } from './ExploreIcons';
import { NftArt } from './NftCollection';
import { NftTradeSheet, type TradeIntent } from './NftTradeSheet';
import { ethFromWei, groupByCollection, usdLabel } from '../lib/nftFormat';

type MyOffer = {
  offerId: string;
  collection: string;
  collectionName: string;
  tokenId: string | null;
  amountWei: string;
  expiry: number;
  expired: boolean;
  image: string | null;
};

/** Same mask as the balances above, for offer amounts. */
const HIDDEN = '••••';

const ROW = 'flex min-h-[53.5px] w-full items-center gap-[10px] rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] py-[4px] pl-[7px] pr-[8px]';

function totalWei(offers: MyOffer[]): bigint {
  return offers.reduce((sum, o) => {
    try {
      return sum + BigInt(o.amountWei);
    } catch {
      return sum;
    }
  }, 0n);
}

/**
 * The offers this wallet has made and not yet had accepted, expired ones
 * included: their ETH stays in the marketplace until cancelled. The card opens
 * on tap, and two or more offers on one collection sit in that collection's
 * own row, which opens on tap. Cancel takes the account password and returns
 * the ETH to the wallet.
 */
export function WalletOffers({ hidden }: { hidden: boolean }) {
  const [offers, setOffers] = useState<MyOffer[] | null>(null);
  const [usdPerEth, setUsdPerEth] = useState<number | null>(null);
  const [network, setNetwork] = useState('GIWA Sepolia');
  const [error, setError] = useState('');
  const [intent, setIntent] = useState<TradeIntent | null>(null);
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/nfts/offers');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load your offers.');
      setOffers(Array.isArray(body.made) ? body.made : []);
      setUsdPerEth(typeof body.usdPerEth === 'number' ? body.usdPerEth : null);
      if (typeof body.network === 'string') setNetwork(body.network);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your offers.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => groupByCollection(offers ?? []), [offers]);

  // Nothing to show and nothing went wrong: the card stays out of the way.
  if (offers && offers.length === 0 && !error) return null;

  const expired = (offers ?? []).filter((o) => o.expired).length;
  const subtitle =
    offers && !error && !hidden
      ? `${offers.length} ${offers.length === 1 ? 'offer' : 'offers'} · ${ethFromWei(totalWei(offers))} ETH held${expired ? ` · ${expired} expired` : ''}`
      : 'ETH held by the marketplace until accepted or cancelled.';

  function toggleGroup(collection: string) {
    setOpenGroups((prev) => {
      const nextOpen = new Set(prev);
      if (nextOpen.has(collection)) nextOpen.delete(collection);
      else nextOpen.add(collection);
      return nextOpen;
    });
  }

  function offerRow(o: MyOffer) {
    const what = o.tokenId ? `${o.collectionName} #${o.tokenId}` : `Any ${o.collectionName}`;
    const usd = usdLabel(o.amountWei, usdPerEth);
    const href = o.tokenId ? `/dashboard/explore/nfts/${o.collection}/${o.tokenId}` : `/dashboard/explore/nfts/${o.collection}`;
    return (
      <li key={o.offerId} className={ROW}>
        <Link href={href} className="flex min-w-0 flex-1 items-center gap-[10px] no-underline">
          <NftArt src={o.image} alt="" initial={o.collectionName} className="h-[45px] w-[45px] shrink-0 rounded-[4px]" />
          <span className="min-w-0">
            <span className="block truncate font-sans text-[11.5px] font-medium text-white">{what}</span>
            <span className="block truncate font-sans text-[9.3px] text-[#a9a9a9]">
              {hidden ? HIDDEN : `${ethFromWei(o.amountWei)} ETH`}
              {!hidden && usd ? ` · ${usd}` : ''}
            </span>
            <span className={`block font-sans text-[9px] ${o.expired ? 'text-sun' : 'text-[#7d7d7d]'}`}>
              {o.expired
                ? 'Expired. Cancel it to get your ETH back.'
                : `Open until ${new Date(o.expiry * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
            </span>
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setIntent({ action: 'offer-cancel', offerId: o.offerId, name: what, amountWei: o.amountWei })}
          className="hit-y-44 h-[28px] shrink-0 rounded-[4px] border border-[#3a3b40] bg-[#0f0f10] px-[10px] font-sans text-[9.6px] text-[#ececec] hover:text-white"
        >
          Cancel
        </button>
      </li>
    );
  }

  return (
    <AppCollapsibleCard
      id="wallet-offers"
      icon={<TagIcon size={15} />}
      title="Your offers"
      subtitle={subtitle}
      open={open}
      onToggle={() => setOpen((o) => !o)}
    >
      <ul className="m-0 mt-[11px] grid list-none gap-[5px] p-0">
        {error ? (
          <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">{error}</li>
        ) : null}
        {!offers && !error ? (
          <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">Loading...</li>
        ) : null}
        {groups.map((g) => {
          if (g.items.length === 1) return offerRow(g.items[0]);
          const isOpen = openGroups.has(g.collection);
          const late = g.items.filter((o) => o.expired).length;
          const panel = `wallet-offers-${g.collection.toLowerCase()}`;
          return (
            <li key={g.collection}>
              <button
                type="button"
                onClick={() => toggleGroup(g.collection)}
                aria-expanded={isOpen}
                aria-controls={panel}
                className={`${ROW} text-left`}
              >
                <NftArt src={g.items[0].image} alt="" initial={g.items[0].collectionName} className="h-[45px] w-[45px] shrink-0 rounded-[4px]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-sans text-[11.5px] font-medium text-white">{g.items[0].collectionName}</span>
                  <span className="block truncate font-sans text-[9.3px] text-[#a9a9a9]">
                    {g.items.length} offers · {hidden ? HIDDEN : `${ethFromWei(totalWei(g.items))} ETH`}
                  </span>
                  {late ? <span className="block font-sans text-[9px] text-sun">{late} expired. Cancel to get the ETH back.</span> : null}
                </span>
                <ChevronDownIcon
                  size={13}
                  className={`mr-[4px] shrink-0 text-[#cfcfcf] transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {isOpen ? (
                <ul id={panel} className="m-0 ml-[29px] mt-[5px] grid list-none gap-[5px] border-l border-[#2a2b30] p-0 pl-[9px]">
                  {g.items.map(offerRow)}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Link
        href="/dashboard/explore/nfts/me?tab=made"
        className="mt-[8px] flex h-[32px] items-center justify-center rounded-[5px] border border-[#1f1f22] font-sans text-[9.6px] text-[#ececec] no-underline hover:text-white"
      >
        Manage offers
      </Link>
      {intent ? (
        <NftTradeSheet
          intent={intent}
          royaltyBps={0}
          usdPerEth={usdPerEth}
          network={network}
          onClose={() => setIntent(null)}
          onDone={load}
        />
      ) : null}
    </AppCollapsibleCard>
  );
}
