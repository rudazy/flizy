'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDashboard } from './DashboardProvider';
import { ArrowLeftIcon, CheckIcon } from './ExploreIcons';
import { NftArt } from './NftCollection';
import { NftTradeSheet, type TradeIntent } from './NftTradeSheet';
import { ethFromWei, shortAddr, usdLabel } from '../lib/nftFormat';

type BookOffer = {
  offerId: string;
  collection: string;
  collectionName: string;
  tokenId: string | null;
  amountWei: string;
  expiry: number;
  expired: boolean;
  maker: string;
  makerLabel: string | null;
  image: string | null;
  myTokenIds: string[];
  royaltyBps: number;
};

type MyNft = {
  collection: string;
  collectionName: string;
  tokenId: string;
  name: string;
  image: string | null;
  verified: boolean;
  listedWei: string | null;
};

type PastBid = {
  offerId: string;
  collection: string;
  collectionName: string;
  tokenId: string | null;
  amountWei: string;
  outcome: 'accepted' | 'cancelled';
  madeAt: string | null;
  closedAt: string | null;
  txHash: string;
  image: string | null;
};

type LikedNft = MyNft & { likedAt: string | null };

const TABS = [
  { id: 'items', label: 'Items' },
  { id: 'received', label: 'Offers received' },
  { id: 'made', label: 'Offers made' },
  { id: 'past', label: 'Past bids' },
  { id: 'liked', label: 'Likes' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function endsLabel(o: BookOffer): string {
  if (o.expired) return 'Expired';
  return `Open until ${new Date(o.expiry * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/**
 * The viewer's own NFT page: what they hold, the offers they can accept or
 * decline, the offers they made (each cancellable for its full amount), their
 * past bids, accepted or cancelled, and the NFTs they hearted.
 */
export function NftProfile() {
  const router = useRouter();
  const pathname = usePathname() || '';
  const search = useSearchParams();
  const raw = search.get('tab');
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : 'items';
  const { data: dash, explorerBase } = useDashboard();

  const [nfts, setNfts] = useState<MyNft[] | null>(null);
  const [book, setBook] = useState<{ made: BookOffer[]; received: BookOffer[]; past: PastBid[] } | null>(null);
  const [liked, setLiked] = useState<LikedNft[] | null>(null);
  const [likedError, setLikedError] = useState('');
  const [usdPerEth, setUsdPerEth] = useState<number | null>(null);
  const [network, setNetwork] = useState('GIWA Sepolia');
  const [enabled, setEnabled] = useState(true);
  const [bookError, setBookError] = useState('');
  const [nftsError, setNftsError] = useState('');
  const [intent, setIntent] = useState<{ intent: TradeIntent; royaltyBps: number } | null>(null);

  const loadBook = useCallback(async () => {
    try {
      const res = await fetch('/api/nfts/offers');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load your offers.');
      setBook({ made: body.made ?? [], received: body.received ?? [], past: body.past ?? [] });
      setUsdPerEth(typeof body.usdPerEth === 'number' ? body.usdPerEth : null);
      setEnabled(body.enabled !== false);
      if (typeof body.network === 'string') setNetwork(body.network);
      setBookError('');
    } catch (e) {
      setBookError(e instanceof Error ? e.message : 'Could not load your offers.');
    }
  }, []);

  const loadNfts = useCallback(async () => {
    try {
      const res = await fetch('/api/nfts/mine');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load your NFTs.');
      setNfts(Array.isArray(body.nfts) ? body.nfts : []);
      setNftsError('');
    } catch (e) {
      setNftsError(e instanceof Error ? e.message : 'Could not load your NFTs.');
    }
  }, []);

  const loadLiked = useCallback(async () => {
    try {
      const res = await fetch('/api/nfts/liked');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load your likes.');
      setLiked(Array.isArray(body.liked) ? body.liked : []);
      setLikedError('');
    } catch (e) {
      setLikedError(e instanceof Error ? e.message : 'Could not load your likes.');
    }
  }, []);

  useEffect(() => {
    loadBook();
    loadNfts();
    loadLiked();
  }, [loadBook, loadNfts, loadLiked]);

  function setTab(next: TabId) {
    const params = new URLSearchParams(search.toString());
    if (next === 'items') params.delete('tab');
    else params.set('tab', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const name = dash?.account.display_name || (dash?.account.username ? `@${dash.account.username}` : 'Your NFTs');
  const wallet = dash?.account.agent_wallet_address || null;
  const counts: Record<TabId, number | null> = {
    items: nfts?.length ?? null,
    received: book?.received.length ?? null,
    made: book?.made.length ?? null,
    past: book?.past.length ?? null,
    liked: liked?.length ?? null,
  };
  const tabError = tab === 'items' ? nftsError : tab === 'liked' ? likedError : bookError;

  return (
    <div className="-mt-4 w-full min-w-0 pb-[calc(var(--app-nav-clearance)+16px)] md:pb-16">
      <header className="sticky top-0 z-40 -mx-4 flex h-[60px] items-center gap-[10px] bg-ink/90 px-4 backdrop-blur-md sm:-mx-6 sm:px-6">
        <Link
          href="/dashboard/explore?s=nfts"
          aria-label="Back to NFTs"
          className="hit-44 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-[#141416] text-white no-underline"
        >
          <ArrowLeftIcon size={19} />
        </Link>
        <h1 className="m-0 font-sans text-[17px] font-semibold text-white">My NFTs</h1>
      </header>

      <section className="mt-[6px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[14px]">
        <p className="m-0 truncate font-sans text-[18px] font-bold text-white">{name}</p>
        {wallet ? <p className="m-0 mt-[2px] font-sans text-[12px] text-[#a9a9a9]">{shortAddr(wallet)}</p> : null}
        <div className="mt-[12px] grid grid-cols-3 gap-y-[12px] sm:grid-cols-5">
          {TABS.map((t, i) => (
            <div
              key={t.id}
              className={`min-w-0 border-[#23242a] ${i % 3 ? 'border-l pl-[12px]' : ''} ${i ? 'sm:border-l sm:pl-[12px]' : ''}`}
            >
              <span className="block font-sans text-[19px] font-semibold text-white">{counts[t.id] ?? '-'}</span>
              <span className="block truncate font-sans text-[11px] text-[#a9a9a9]">{t.label}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-[16px] flex overflow-x-auto border-b border-[#23242a] [scrollbar-width:none]" role="tablist" aria-label="My NFTs sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`hit-y-44 relative -mb-px shrink-0 px-[14px] pb-[11px] pt-[4px] font-sans text-[14px] ${
              tab === t.id ? 'font-semibold text-sun' : 'text-[#cfcfcf] hover:text-white'
            }`}
          >
            {t.label}
            {tab === t.id ? <span className="absolute inset-x-[10px] bottom-0 h-[2px] rounded-full bg-sun" aria-hidden /> : null}
          </button>
        ))}
      </div>

      {/* Each tab shows only the error of what it loads. */}
      {tabError ? <p className="alert alert-error m-0 mt-[12px]">{tabError}</p> : null}
      {!enabled ? <p className="m-0 mt-[12px] font-sans text-[12.5px] text-[#a9a9a9]">Trading opens when the Flizy marketplace goes live.</p> : null}

      {tab === 'items' ? (
        <div className="mt-[14px]">
          {!nfts && !nftsError ? <Muted>Loading...</Muted> : null}
          {nfts && nfts.length === 0 && !nftsError ? <Muted>NFTs appear here after you mint, buy or receive them.</Muted> : null}
          <div className={GRID}>
            {(nfts ?? []).map((n) => (
              <NftTile key={`${n.collection}:${n.tokenId}`} nft={n} />
            ))}
          </div>
        </div>
      ) : null}

      {tab === 'received' ? (
        <div className="mt-[12px] grid grid-cols-[minmax(0,1fr)] gap-[8px]">
          {!book && !bookError ? <Muted>Loading...</Muted> : null}
          {book && book.received.length === 0 ? <Muted>No open offers on your NFTs.</Muted> : null}
          {(book?.received ?? []).map((o) => (
            <ReceivedRow
              key={o.offerId}
              offer={o}
              usdPerEth={usdPerEth}
              onAccept={(tokenId) =>
                setIntent({
                  intent: {
                    action: 'offer-accept',
                    offerId: o.offerId,
                    tokenId,
                    name: `${o.collectionName} #${tokenId}`,
                    amountWei: o.amountWei,
                  },
                  royaltyBps: o.royaltyBps,
                })
              }
              onDeclined={loadBook}
            />
          ))}
        </div>
      ) : null}

      {tab === 'made' ? (
        <div className="mt-[12px] grid grid-cols-[minmax(0,1fr)] gap-[8px]">
          {!book && !bookError ? <Muted>Loading...</Muted> : null}
          {book && book.made.length === 0 ? <Muted>You have no open offers.</Muted> : null}
          {(book?.made ?? []).map((o) => {
            const what = o.tokenId ? `${o.collectionName} #${o.tokenId}` : `Any ${o.collectionName}`;
            return (
              <OfferRow key={o.offerId} offer={o} what={what} usdPerEth={usdPerEth} detail={o.expired ? 'Expired. Cancel it to get your ETH back.' : endsLabel(o)} warn={o.expired}>
                <button
                  type="button"
                  onClick={() => setIntent({ intent: { action: 'offer-cancel', offerId: o.offerId, name: what, amountWei: o.amountWei }, royaltyBps: 0 })}
                  className="h-[34px] shrink-0 rounded-[8px] border border-[#3a3b40] px-[12px] font-sans text-[12.5px] text-white"
                >
                  Cancel
                </button>
              </OfferRow>
            );
          })}
        </div>
      ) : null}

      {tab === 'past' ? (
        <div className="mt-[12px] grid grid-cols-[minmax(0,1fr)] gap-[8px]">
          {!book && !bookError ? <Muted>Loading...</Muted> : null}
          {book && book.past.length === 0 ? <Muted>Offers you made show here once they are accepted or cancelled.</Muted> : null}
          {(book?.past ?? []).map((b) => (
            <PastBidRow key={`${b.offerId}:${b.txHash}`} bid={b} usdPerEth={usdPerEth} explorerBase={explorerBase} />
          ))}
        </div>
      ) : null}

      {tab === 'liked' ? (
        <div className="mt-[14px]">
          {!liked && !likedError ? <Muted>Loading...</Muted> : null}
          {liked && liked.length === 0 && !likedError ? <Muted>NFTs you heart on a collection page show here.</Muted> : null}
          <div className={GRID}>
            {(liked ?? []).map((n) => (
              <NftTile key={`${n.collection}:${n.tokenId}`} nft={n} />
            ))}
          </div>
        </div>
      ) : null}

      {intent ? (
        <NftTradeSheet
          intent={intent.intent}
          royaltyBps={intent.royaltyBps}
          usdPerEth={usdPerEth}
          network={network}
          onClose={() => setIntent(null)}
          onDone={() => {
            loadBook();
            loadNfts();
          }}
        />
      ) : null}
    </div>
  );
}

/** Two cards across on a phone, more as the screen widens. */
const GRID = 'grid grid-cols-2 gap-[10px] sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

function Muted({ children }: { children: ReactNode }) {
  return <p className="m-0 font-sans text-[12.5px] text-[#a9a9a9]">{children}</p>;
}

function NftTile({ nft }: { nft: MyNft }) {
  return (
    <Link
      href={`/dashboard/explore/nfts/${nft.collection}/${nft.tokenId}`}
      className="min-w-0 overflow-hidden rounded-[12px] border border-[#23242a] bg-[#0d0d0e] no-underline"
    >
      <NftArt src={nft.image} alt={nft.name} initial={nft.collectionName} className="aspect-square w-full" />
      <div className="px-[10px] pb-[10px] pt-[8px]">
        <p className="m-0 flex items-center gap-[5px] font-sans text-[13px] font-medium text-white">
          <span className="truncate">{nft.name}</span>
          {nft.verified ? (
            <span className="inline-flex h-[12px] w-[12px] shrink-0 items-center justify-center rounded-full bg-sun text-[#1a1405]">
              <CheckIcon size={8} strokeWidth={3} />
            </span>
          ) : null}
        </p>
        <p className="m-0 mt-[3px] font-sans text-[11.5px] text-[#9a9a9a]">
          {nft.listedWei ? `Listed for ${ethFromWei(nft.listedWei)} ETH` : 'Not listed'}
        </p>
      </div>
    </Link>
  );
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** A closed offer: accepted, so the NFT came to this wallet, or cancelled, so the ETH went back. */
function PastBidRow({ bid, usdPerEth, explorerBase }: { bid: PastBid; usdPerEth: number | null; explorerBase: string }) {
  const accepted = bid.outcome === 'accepted';
  const what = bid.tokenId ? `${bid.collectionName} #${bid.tokenId}` : `Any ${bid.collectionName}`;
  const usd = usdLabel(bid.amountWei, usdPerEth);
  const href = bid.tokenId ? `/dashboard/explore/nfts/${bid.collection}/${bid.tokenId}` : `/dashboard/explore/nfts/${bid.collection}`;
  const when = shortDate(bid.closedAt);
  return (
    <div className="flex items-center gap-[12px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[8px]">
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-[12px] no-underline">
        <NftArt src={bid.image} alt="" initial={bid.collectionName} className="h-[54px] w-[54px] shrink-0 rounded-[9px]" />
        <div className="min-w-0">
          <p className="m-0 truncate font-sans text-[13.5px] font-medium text-white">{what}</p>
          <p className="m-0 mt-[2px] truncate font-sans text-[12px] text-white">
            {ethFromWei(bid.amountWei)} ETH{usd ? <span className="text-[#9a9a9a]"> · {usd}</span> : null}
          </p>
          <p className="m-0 mt-[2px] truncate font-sans text-[11px] text-[#8d8d8d]">
            {accepted ? 'Accepted. The NFT came to your wallet.' : 'Cancelled. The ETH went back to your wallet.'}
            {when ? ` ${when}` : ''}
          </p>
        </div>
      </Link>
      <div className="flex shrink-0 flex-col items-end gap-[6px]">
        <span
          className={`rounded-full border px-[8px] py-[2px] font-sans text-[11px] ${
            accepted ? 'border-[#1f6b45] bg-[#123224] text-[#3ddc84]' : 'border-[#3a3b40] bg-[#141416] text-[#cfcfcf]'
          }`}
        >
          {accepted ? 'Accepted' : 'Cancelled'}
        </span>
        <a
          href={`${explorerBase}/tx/${bid.txHash}`}
          target="_blank"
          rel="noreferrer"
          className="hit-y-44 font-sans text-[11px] text-[#a9a9a9] no-underline hover:text-white"
        >
          Transaction
        </a>
      </div>
    </div>
  );
}

function OfferRow({
  offer,
  what,
  usdPerEth,
  detail,
  warn = false,
  children,
}: {
  offer: BookOffer;
  what: string;
  usdPerEth: number | null;
  detail: string;
  warn?: boolean;
  children: ReactNode;
}) {
  const usd = usdLabel(offer.amountWei, usdPerEth);
  const href = offer.tokenId ? `/dashboard/explore/nfts/${offer.collection}/${offer.tokenId}` : `/dashboard/explore/nfts/${offer.collection}`;
  return (
    <div className="flex items-center gap-[12px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[8px]">
      <Link href={href} className="flex min-w-0 flex-1 items-center gap-[12px] no-underline">
        <NftArt src={offer.image} alt="" initial={offer.collectionName} className="h-[54px] w-[54px] shrink-0 rounded-[9px]" />
        <div className="min-w-0">
          <p className="m-0 truncate font-sans text-[13.5px] font-medium text-white">{what}</p>
          <p className="m-0 mt-[2px] truncate font-sans text-[12px] text-white">
            {ethFromWei(offer.amountWei)} ETH{usd ? <span className="text-[#9a9a9a]"> · {usd}</span> : null}
          </p>
          <p className={`m-0 mt-[2px] truncate font-sans text-[11px] ${warn ? 'text-sun' : 'text-[#8d8d8d]'}`}>{detail}</p>
        </div>
      </Link>
      <div className="flex shrink-0 flex-col gap-[6px]">{children}</div>
    </div>
  );
}

function ReceivedRow({
  offer,
  usdPerEth,
  onAccept,
  onDeclined,
}: {
  offer: BookOffer;
  usdPerEth: number | null;
  onAccept: (tokenId: string) => void;
  onDeclined: () => void;
}) {
  const [pick, setPick] = useState(offer.tokenId ?? offer.myTokenIds[0] ?? '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const what = offer.tokenId ? `${offer.collectionName} #${offer.tokenId}` : `Any ${offer.collectionName}`;
  const from = offer.makerLabel ?? shortAddr(offer.maker);

  async function decline() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/nfts/offers/decline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offerId: offer.offerId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not decline this offer.');
      onDeclined();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not decline this offer.');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-[6px]">
      <OfferRow offer={offer} what={what} usdPerEth={usdPerEth} detail={`From ${from} · ${endsLabel(offer)}`}>
        <button
          type="button"
          disabled={!pick}
          onClick={() => onAccept(pick)}
          className="btn-sun h-[34px] rounded-[8px] px-[12px] font-sans text-[12.5px] disabled:opacity-50"
        >
          Accept
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={decline}
          className={`h-[34px] rounded-[8px] border px-[12px] font-sans text-[12.5px] ${confirming ? 'border-sun text-sun' : 'border-[#3a3b40] text-white'}`}
        >
          {busy ? '...' : confirming ? 'Sure?' : 'Decline'}
        </button>
      </OfferRow>
      {!offer.tokenId && offer.myTokenIds.length > 1 ? (
        <label className="flex items-center gap-[8px] px-[8px] font-sans text-[12px] text-[#a9a9a9]">
          Sell
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="h-[32px] rounded-[8px] border border-[#2a2b30] bg-[#0b0b0c] px-[8px] font-sans text-[12.5px] text-white"
          >
            {offer.myTokenIds.map((id) => (
              <option key={id} value={id}>
                {offer.collectionName} #{id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {confirming ? (
        <p className="m-0 px-[8px] font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
          Declining hides this offer from you and tells {from} in chat. Their ETH stays theirs until they cancel. Tap Sure? to decline.
        </p>
      ) : null}
      {error ? <p className="alert alert-error m-0">{error}</p> : null}
    </div>
  );
}
