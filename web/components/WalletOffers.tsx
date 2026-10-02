'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppCard as Card, AppCardHeader as CardHeader } from './AppCard';
import { TagIcon } from './ExploreIcons';
import { NftArt } from './NftCollection';
import { NftTradeSheet, type TradeIntent } from './NftTradeSheet';
import { ethFromWei, usdLabel } from '../lib/nftFormat';

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

/**
 * The offers this wallet has made and not yet had accepted, expired ones
 * included: their ETH stays in the marketplace until cancelled. Cancel takes
 * the account password and returns the ETH to the wallet.
 */
export function WalletOffers({ hidden }: { hidden: boolean }) {
  const [offers, setOffers] = useState<MyOffer[] | null>(null);
  const [usdPerEth, setUsdPerEth] = useState<number | null>(null);
  const [network, setNetwork] = useState('GIWA Sepolia');
  const [error, setError] = useState('');
  const [intent, setIntent] = useState<TradeIntent | null>(null);

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

  // Nothing to show and nothing went wrong: the card stays out of the way.
  if (offers && offers.length === 0 && !error) return null;

  return (
    <Card className="px-[9.8px] pb-[9.5px] pt-[10.5px]">
      <CardHeader
        icon={<TagIcon size={15} />}
        title="Your offers"
        subtitle="ETH held by the marketplace until accepted or cancelled."
        action={
          <Link
            href="/dashboard/explore/nfts/me?tab=made"
            className="hit-y-44 flex h-[28px] items-center rounded-[4px] border border-[#3a3b40] bg-[#0f0f10] px-[10px] font-sans text-[9.6px] text-[#ececec] no-underline hover:text-white"
          >
            Manage
          </Link>
        }
      />
      <ul className="m-0 mt-[11px] grid list-none gap-[5px] p-0">
        {error ? (
          <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">{error}</li>
        ) : null}
        {!offers && !error ? (
          <li className="rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] px-[10px] py-[12px] font-sans text-[9px] text-[#a9a9a9]">Loading...</li>
        ) : null}
        {(offers ?? []).map((o) => {
          const what = o.tokenId ? `${o.collectionName} #${o.tokenId}` : `Any ${o.collectionName}`;
          const usd = usdLabel(o.amountWei, usdPerEth);
          const href = o.tokenId ? `/dashboard/explore/nfts/${o.collection}/${o.tokenId}` : `/dashboard/explore/nfts/${o.collection}`;
          return (
            <li key={o.offerId} className="flex min-h-[53.5px] items-center gap-[10px] rounded-[5px] border border-[#1f1f22] bg-[#0d0d0e] py-[4px] pl-[7px] pr-[8px]">
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
        })}
      </ul>
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
    </Card>
  );
}
