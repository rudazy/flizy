'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeftIcon, CartIcon, CheckIcon, ExternalLinkIcon, TagIcon } from './ExploreIcons';
import { NftTradeSheet, type TradeIntent } from './NftTradeSheet';
import { NftArt, PriceBlock } from './NftCollection';
import { bpsLabel, ethFromWei, shortAddr, timeAgo, usdLabel } from '../lib/nftFormat';

type Offer = { offerId: string; collection: string; maker: string; tokenId: string | null; amount: string; expiry: number };

type ItemData = {
  collection: { address: string; name: string; verified: boolean; ticker: string | null; standard: string };
  token: {
    tokenId: string;
    name: string;
    image: string | null;
    owner: string;
    priceWei: string | null;
    seller: string | null;
    expiry: number | null;
    traits: Array<{ trait: string; value: string }>;
    description: string | null;
    externalUrl: string | null;
  };
  offers: Offer[];
  transfers: Array<{ kind: string; from: string; to: string; txHash: string; timestamp: string | null }>;
  history: Array<{ kind: string; txHash: string; timestamp: string | null; priceWei?: string }>;
  market: { enabled: boolean; paused: boolean; tradable: boolean; feeBps: number; royaltyBps: number; royaltyReceiver: string | null };
  viewer: { address: string; isOwner: boolean; isSeller: boolean; credits: string; myOffers: string[] };
  usdPerEth: number | null;
  explorerBaseUrl: string;
  network: string;
};

const HISTORY_LABEL: Record<string, string> = {
  sold: 'Sold',
  listed: 'Listed',
  listingCancelled: 'Delisted',
  offerMade: 'Offer made',
  mint: 'Minted',
  transfer: 'Transferred',
  burn: 'Burned',
};

/**
 * One NFT: art, price, owner, offers, traits and history, with every action
 * the viewer can take on it. Owner and listing are read from the chain.
 */
export function NftItem({ address, tokenId }: { address: string; tokenId: string }) {
  const [data, setData] = useState<ItemData | null>(null);
  const [error, setError] = useState('');
  const [intent, setIntent] = useState<TradeIntent | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nfts/collections/${address}/tokens/${tokenId}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load this NFT.');
      setData(body as ItemData);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this NFT.');
    }
  }, [address, tokenId]);

  useEffect(() => {
    load();
  }, [load]);

  const back = (
    <header className="sticky top-0 z-40 -mx-4 flex h-[60px] items-center gap-[10px] bg-ink/90 px-4 backdrop-blur-md sm:-mx-6 sm:px-6">
      <Link
        href={`/dashboard/explore/nfts/${address}`}
        aria-label="Back to the collection"
        className="hit-44 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-[#141416] text-white no-underline"
      >
        <ArrowLeftIcon size={19} />
      </Link>
      <h1 className="m-0 min-w-0 truncate font-sans text-[16px] font-semibold text-white">{data?.collection.name ?? 'NFT'}</h1>
    </header>
  );

  if (error && !data) {
    return (
      <div className="-mt-4">
        {back}
        <p className="alert alert-error m-0 mt-4">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="-mt-4">
        {back}
        <p className="m-0 mt-4 font-sans text-[12px] text-[#a9a9a9]">Loading...</p>
      </div>
    );
  }

  const t = data.token;
  const m = data.market;
  const v = data.viewer;
  const listed = t.priceWei != null;
  const credits = BigInt(v.credits || '0');

  const actions: Array<{ label: string; icon: ReactNode; primary: boolean; run: () => void }> = [];
  if (m.tradable && !m.paused) {
    if (v.isOwner) {
      actions.push({
        label: listed ? 'Change price' : 'List for sale',
        icon: <TagIcon size={16} />,
        primary: true,
        run: () => setIntent({ action: 'list', collection: address, tokenId, name: t.name, currentWei: t.priceWei }),
      });
    } else {
      if (listed) {
        actions.push({
          label: 'Buy now',
          icon: <CartIcon size={17} />,
          primary: true,
          run: () => setIntent({ action: 'buy', collection: address, tokenId, name: t.name, priceWei: t.priceWei! }),
        });
      }
      actions.push({
        label: 'Make offer',
        icon: <TagIcon size={16} />,
        primary: !listed,
        run: () => setIntent({ action: 'offer', collection: address, tokenId, name: t.name }),
      });
    }
  }
  if (m.tradable && listed && (v.isSeller || v.isOwner)) {
    actions.push({
      label: 'Cancel listing',
      icon: null,
      primary: false,
      run: () => setIntent({ action: 'cancel', collection: address, tokenId, name: t.name }),
    });
  }

  const history = [
    ...data.history.map((h) => ({ label: HISTORY_LABEL[h.kind] ?? h.kind, txHash: h.txHash, timestamp: h.timestamp, priceWei: h.priceWei ?? null, who: '' })),
    ...data.transfers.map((x) => ({
      label: HISTORY_LABEL[x.kind] ?? x.kind,
      txHash: x.txHash,
      timestamp: x.timestamp,
      priceWei: null,
      who: x.kind === 'mint' ? `to ${shortAddr(x.to)}` : `${shortAddr(x.from)} to ${shortAddr(x.to)}`,
    })),
  ].sort((a, b) => Date.parse(b.timestamp || '0') - Date.parse(a.timestamp || '0'));

  return (
    <div className="-mt-4 w-full min-w-0 pb-[calc(var(--app-nav-clearance)+16px)] md:pb-16">
      {back}

      <div className="mx-auto mt-[6px] max-w-[420px] overflow-hidden rounded-[14px] border border-[#23242a] bg-[#0d0d0e]">
        <NftArt src={t.image} alt={t.name} initial={data.collection.name} className="aspect-square w-full" />
      </div>

      <div className="mt-[16px]">
        <Link href={`/dashboard/explore/nfts/${address}`} className="flex items-center gap-[6px] font-sans text-[13px] text-sun no-underline">
          {data.collection.name}
          {data.collection.verified ? (
            <span className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-full bg-sun text-[#1a1405]">
              <CheckIcon size={9} strokeWidth={3} />
            </span>
          ) : null}
        </Link>
        <h2 className="m-0 mt-[4px] font-sans text-[22px] font-bold text-white">{t.name}</h2>
        <p className="m-0 mt-[4px] font-sans text-[12.5px] text-[#a9a9a9]">
          Owned by{' '}
          <a href={`${data.explorerBaseUrl}/address/${t.owner}`} target="_blank" rel="noreferrer noopener" className="text-white no-underline">
            {v.isOwner ? 'you' : shortAddr(t.owner)}
          </a>
        </p>
      </div>

      <section className="mt-[14px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[14px]">
        <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">{listed ? 'Price' : 'Not listed'}</p>
        {listed ? (
          <div className="mt-[4px]">
            <PriceBlock wei={t.priceWei} usdPerEth={data.usdPerEth} size="lg" />
            {t.expiry ? (
              <p className="m-0 mt-[6px] font-sans text-[11.5px] text-[#8d8d8d]">
                Listing ends {new Date(t.expiry * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="m-0 mt-[4px] font-sans text-[13px] text-white">
            {data.offers.length ? `Best offer ${ethFromWei(data.offers[0].amount)} ETH` : 'No offers yet'}
          </p>
        )}
        {/* The royalty is read from the marketplace, so it is only known once trading is live. */}
        {m.enabled ? (
          <p className="m-0 mt-[10px] font-sans text-[11.5px] text-[#8d8d8d]">
            Flizy fee {bpsLabel(m.feeBps)} · Creator royalty {m.royaltyBps ? bpsLabel(m.royaltyBps) : 'none'}
            {data.usdPerEth != null ? ' · USD at the mainnet ETH price' : ''}
          </p>
        ) : null}
        {actions.length ? (
          <div className={`mt-[12px] grid gap-[8px] ${actions.length > 1 ? 'grid-cols-2' : ''}`}>
            {actions.map((a) =>
              a.primary ? (
                <button key={a.label} type="button" onClick={a.run} className="btn-sun h-[44px] gap-[8px] rounded-[9px] font-sans text-[13.5px]">
                  {a.icon}
                  {a.label}
                </button>
              ) : (
                <button key={a.label} type="button" onClick={a.run} className="flex h-[44px] items-center justify-center gap-[8px] rounded-[9px] border border-[#3a3b40] font-sans text-[13.5px] text-white">
                  {a.icon}
                  {a.label}
                </button>
              )
            )}
          </div>
        ) : !m.enabled ? (
          <p className="m-0 mt-[10px] font-sans text-[12px] text-[#a9a9a9]">Trading opens when the Flizy marketplace goes live.</p>
        ) : m.paused ? (
          <p className="m-0 mt-[10px] font-sans text-[12px] text-sun">Trading is paused right now.</p>
        ) : !m.tradable ? (
          <p className="m-0 mt-[10px] font-sans text-[12px] text-[#a9a9a9]">Only ERC-721 NFTs can be traded here.</p>
        ) : null}
        {credits > 0n ? (
          <button
            type="button"
            onClick={() => setIntent({ action: 'withdraw', amountWei: v.credits })}
            className="mt-[10px] h-[40px] w-full rounded-[9px] border border-sun font-sans text-[12.5px] text-sun"
          >
            Withdraw {ethFromWei(v.credits)} ETH from sales
          </button>
        ) : null}
        {!data.collection.verified ? (
          <p className="m-0 mt-[10px] font-sans text-[11.5px] leading-[16px] text-[#a9a9a9]">
            Not verified by Flizy. It can be traded here but not sent in chat.
          </p>
        ) : null}
      </section>

      <Section title={`Offers${data.offers.length ? ` (${data.offers.length})` : ''}`}>
        {data.offers.length ? (
          <ul className="m-0 list-none p-0">
            {data.offers.map((o) => {
              const mine = v.myOffers.includes(o.offerId);
              return (
                <li key={o.offerId} className="flex items-center gap-[10px] border-b border-[#1b1c20] py-[10px] last:border-0">
                  <div className="min-w-0 flex-1">
                    <p className="m-0 font-sans text-[13px] font-semibold text-white">{ethFromWei(o.amount)} ETH</p>
                    <p className="m-0 mt-[2px] truncate font-sans text-[11.5px] text-[#9a9a9a]">
                      {o.tokenId ? 'For this NFT' : 'Collection offer'} · from {mine ? 'you' : shortAddr(o.maker)}
                      {usdLabel(o.amount, data.usdPerEth) ? ` · ${usdLabel(o.amount, data.usdPerEth)}` : ''}
                    </p>
                  </div>
                  {v.isOwner && !mine && m.tradable && !m.paused ? (
                    <button
                      type="button"
                      onClick={() => setIntent({ action: 'offer-accept', offerId: o.offerId, tokenId, name: t.name, amountWei: o.amount })}
                      className="btn-sun h-[34px] shrink-0 rounded-[8px] px-[12px] font-sans text-[12.5px]"
                    >
                      Accept
                    </button>
                  ) : null}
                  {mine && m.enabled ? (
                    <button
                      type="button"
                      onClick={() => setIntent({ action: 'offer-cancel', offerId: o.offerId, name: t.name, amountWei: o.amount })}
                      className="h-[34px] shrink-0 rounded-[8px] border border-[#3a3b40] px-[12px] font-sans text-[12.5px] text-white"
                    >
                      Cancel
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 font-sans text-[12.5px] text-[#a9a9a9]">No open offers.</p>
        )}
      </Section>

      {t.description ? (
        <Section title="Description">
          <p className="m-0 font-sans text-[13px] leading-[19px] text-[#d6d6d6]">{t.description}</p>
        </Section>
      ) : null}

      <Section title="Traits">
        {t.traits.length ? (
          <div className="grid grid-cols-2 gap-[8px]">
            {t.traits.map((tr) => (
              <div key={`${tr.trait}:${tr.value}`} className="rounded-[9px] border border-[#2a2b30] px-[10px] py-[8px]">
                <p className="m-0 truncate font-sans text-[10.5px] uppercase tracking-wide text-[#a9a9a9]">{tr.trait}</p>
                <p className="m-0 mt-[2px] truncate font-sans text-[13px] text-white">{tr.value}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="m-0 font-sans text-[12.5px] text-[#a9a9a9]">No traits in this token&apos;s metadata.</p>
        )}
      </Section>

      <Section title="History">
        {history.length ? (
          <ul className="m-0 list-none p-0">
            {history.map((h, i) => (
              <li key={`${h.txHash}-${i}`} className="flex items-center gap-[10px] border-b border-[#1b1c20] py-[10px] last:border-0">
                <div className="min-w-0 flex-1">
                  <p className="m-0 font-sans text-[13px] text-white">
                    {h.label}
                    {h.priceWei ? <span className="text-[#cfcfcf]"> · {ethFromWei(h.priceWei)} ETH</span> : null}
                  </p>
                  {h.who ? <p className="m-0 mt-[2px] truncate font-sans text-[11.5px] text-[#9a9a9a]">{h.who}</p> : null}
                </div>
                <a href={`${data.explorerBaseUrl}/tx/${h.txHash}`} target="_blank" rel="noreferrer noopener" className="flex shrink-0 items-center gap-[5px] font-sans text-[11.5px] text-[#9a9a9a] no-underline">
                  {timeAgo(h.timestamp)}
                  <ExternalLinkIcon size={11} />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 font-sans text-[12.5px] text-[#a9a9a9]">No history yet.</p>
        )}
      </Section>

      <Section title="Details">
        <dl className="m-0">
          {[
            ['Contract', shortAddr(address)],
            ['Token ID', tokenId.length > 18 ? `${tokenId.slice(0, 8)}...${tokenId.slice(-6)}` : tokenId],
            ['Standard', data.collection.standard],
            ['Network', data.network],
            ['Send in chat', data.collection.verified ? `Yes, as ${data.collection.ticker}` : 'No'],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-[16px] border-b border-[#1b1c20] py-[9px] last:border-0">
              <dt className="font-sans text-[12.5px] text-[#a9a9a9]">{label}</dt>
              <dd className="m-0 truncate font-sans text-[12.5px] text-white">{value}</dd>
            </div>
          ))}
        </dl>
        {t.externalUrl ? (
          <a href={t.externalUrl} target="_blank" rel="noreferrer noopener" className="mt-[8px] inline-flex items-center gap-[6px] font-sans text-[12px] text-sun no-underline">
            Project link <ExternalLinkIcon size={11} />
          </a>
        ) : null}
      </Section>

      {intent ? (
        <NftTradeSheet
          intent={intent}
          royaltyBps={m.royaltyBps}
          usdPerEth={data.usdPerEth}
          network={data.network}
          onClose={() => setIntent(null)}
          onDone={load}
        />
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-[18px]">
      <h3 className="m-0 mb-[8px] font-sans text-[15px] font-bold text-white">{title}</h3>
      <div className="rounded-[12px] border border-[#23242a] bg-[#0d0d0e] px-[14px] py-[10px]">{children}</div>
    </section>
  );
}
