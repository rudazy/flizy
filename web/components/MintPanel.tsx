'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDashboard } from './DashboardProvider';
import { MintActionSheet, SheetRow, EthAmount } from './MintActionSheet';
import { NftArt } from './NftCollection';
import { artworkFor } from '../lib/nftArtwork';
import { CheckIcon, ClockIcon, EthDiamondIcon, ShieldCheckIcon } from './ExploreIcons';
import { bpsLabel, ethFromWei, shortAddr, usdLabel } from '../lib/nftFormat';
import { countdown, isLiveStatus, scheduleSteps, statusLabel, type MintStatus } from '../lib/mintFormat';

export type MintDrop = {
  collection: string;
  mode: 'flizy' | 'external';
  name: string;
  description: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  verified: boolean;
  ticker: string | null;
  creatorUsername: string | null;
  status: MintStatus;
  contractManaged: boolean;
  minted: number;
  maxSupply: number | null;
  priceWei: string | null;
  config: { allowlistStart: number; allowlistEnd: number; publicStart: number; mintEnd: number; allowlistPriceWei: string; publicPriceWei: string; publicLimit: number } | null;
  allowlistLive: boolean;
  publicLive: boolean;
  nextChangeAt: number | null;
  feeBps: number;
  royaltyBps: number | null;
};

type Viewer = {
  wallet: string;
  allowlist: { listed: boolean; allowance: number; minted: number; remaining: number } | null;
  public: { minted: number; limit: number; remaining: number } | null;
  now: { phase: 'allowlist' | 'public' | 'external'; maxQuantity: number; priceWei: string | null } | null;
  reason: string | null;
};

type MintData = { drop: MintDrop; viewer: Viewer; isCreator: boolean; usdPerEth: number | null };

export function MintStatusPill({ status, contractManaged }: { status: MintStatus; contractManaged: boolean }) {
  const live = isLiveStatus(status);
  return (
    <span
      className={`inline-flex h-[22px] items-center gap-[6px] rounded-full border px-[9px] font-sans text-[11px] ${
        live ? 'border-sun text-sun' : 'border-[#3a3b40] text-[#cfcfcf]'
      }`}
    >
      {live ? <span className="h-[6px] w-[6px] rounded-full bg-sun" aria-hidden /> : null}
      {statusLabel(status, contractManaged)}
    </span>
  );
}

/** Flizy Mint runs on one network; the label matches the rest of the NFT pages. */
const NETWORK = 'GIWA Sepolia';

function useNow(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * The Mint experience: supply, price, what this wallet may mint now and why,
 * the quantity, and the Mint button, then the schedule and the facts about
 * the collection. Contract-managed drops say plainly that the contract, not
 * Flizy, sets the rules.
 */
export function MintPanel({
  collection,
  onMinted,
  hero = false,
}: {
  collection: string;
  onMinted?: () => void;
  /** The standalone mint page shows the art, name and creator above the card. */
  hero?: boolean;
}) {
  const { explorerBase } = useDashboard();
  const [data, setData] = useState<MintData | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [sheet, setSheet] = useState(false);
  const now = useNow();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/mints/${collection}`);
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setMissing(true);
        return;
      }
      if (!res.ok) throw new Error(body.error || 'Could not load this mint.');
      setData(body as MintData);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this mint.');
    }
  }, [collection]);

  useEffect(() => {
    load();
  }, [load]);

  // Reload when a scheduled change arrives, so the status flips on time.
  const nextChangeAt = data?.drop.nextChangeAt ?? null;
  useEffect(() => {
    if (!nextChangeAt) return;
    const wait = nextChangeAt * 1000 - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(load, wait + 1500);
    return () => clearTimeout(t);
  }, [nextChangeAt, load]);

  useEffect(() => {
    const max = data?.viewer.now?.maxQuantity ?? 1;
    setQuantity((q) => Math.min(Math.max(1, q), max));
  }, [data?.viewer.now?.maxQuantity]);

  if (missing) return <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">This collection does not mint through Flizy.</p>;
  if (error) return <p className="alert alert-error m-0">{error}</p>;
  if (!data) return <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">Loading mint...</p>;

  const { drop: d, viewer: v, usdPerEth } = data;
  const network = NETWORK;
  const remaining = d.maxSupply != null ? Math.max(0, d.maxSupply - d.minted) : null;
  const pct = d.maxSupply ? Math.min(100, (d.minted / d.maxSupply) * 100) : 0;
  const price = v.now?.priceWei ?? d.priceWei;
  const free = price === '0';
  const max = v.now?.maxQuantity ?? 1;
  const total = price != null ? BigInt(price) * BigInt(quantity) : null;
  const fee = total != null ? (total * BigInt(d.feeBps)) / 10_000n : null;
  const c = d.config;

  return (
    <div className="grid gap-[14px]">
      {hero ? (
        <header className="grid gap-[12px]">
          {d.bannerUrl || artworkFor(d.imageUrl, d.ticker) ? (
            <div className="relative h-[150px] overflow-hidden rounded-[12px] border border-[#23242a]">
              <NftArt src={d.bannerUrl ?? artworkFor(d.imageUrl, d.ticker)} alt={`${d.name} banner`} initial={d.name} className="h-full w-full" />
            </div>
          ) : null}
          <div className="flex items-start gap-[12px]">
            <NftArt src={artworkFor(d.imageUrl, d.ticker)} alt={`${d.name} artwork`} initial={d.name} className="h-[64px] w-[64px] shrink-0 rounded-[12px]" />
            <div className="min-w-0">
              <h1 className="m-0 truncate font-sans text-[20px] font-bold text-white">{d.name}</h1>
              <p className="m-0 mt-[3px] font-sans text-[12.5px] text-[#cfcfcf]">
                {d.creatorUsername ? `By @${d.creatorUsername}` : d.verified ? 'By Flizy' : 'Creator unknown'}
              </p>
              <span
                className={`mt-[6px] inline-flex h-[22px] items-center gap-[5px] rounded-full border px-[9px] font-sans text-[11px] ${
                  d.verified ? 'border-sun text-sun' : 'border-[#5a4a1c] text-sun'
                }`}
              >
                {d.verified ? <ShieldCheckIcon size={12} /> : null}
                {d.verified ? 'Verified collection' : 'Not verified by Flizy'}
              </span>
            </div>
          </div>
          {!d.verified ? (
            <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
              Anyone can launch a mint on Flizy. Flizy has not checked this collection: compare the contract address with the
              creator&apos;s own links before you mint. Unverified NFTs can be traded here but cannot be sent in chat.
            </p>
          ) : null}
        </header>
      ) : null}

      {/* Mint card */}
      <section className="grid gap-[12px] rounded-[12px] border border-[#2a2b30] bg-[#0d0d0e] p-[14px]" aria-label="Mint">
        <div className="flex items-center justify-between gap-[10px]">
          <MintStatusPill status={d.status} contractManaged={d.contractManaged} />
          <span className="font-sans text-[11px] text-[#a9a9a9]">
            {d.contractManaged ? 'Contract-managed' : 'Managed by Flizy'}
          </span>
        </div>

        <div>
          <div className="flex items-baseline gap-[8px]">
            <span className="inline-flex items-center gap-[6px] font-sans text-[26px] font-bold text-white">
              <EthDiamondIcon size={18} className="text-[#cfcfcf]" />
              {price == null ? 'Price set by the contract' : free ? 'Free mint' : `${ethFromWei(price)} ETH`}
            </span>
          </div>
          {price && !free && usdLabel(price, usdPerEth) ? (
            <p className="m-0 mt-[2px] font-sans text-[11.5px] text-[#9a9a9a]">{usdLabel(price, usdPerEth)} each, at the mainnet ETH price</p>
          ) : null}
        </div>

        <div className="grid gap-[6px]">
          <div className="flex items-center justify-between font-sans text-[12px]">
            <span className="text-white">{d.minted.toLocaleString('en-US')} minted</span>
            <span className="text-[#a9a9a9]">
              {d.maxSupply != null ? `${remaining?.toLocaleString('en-US')} of ${d.maxSupply.toLocaleString('en-US')} left` : 'Supply not published'}
            </span>
          </div>
          {d.maxSupply ? (
            <div className="h-[6px] overflow-hidden rounded-full bg-[#1d1e22]" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Minted">
              <div className="h-full rounded-full bg-sun" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
        </div>

        <Eligibility drop={d} viewer={v} now={now} />

        {v.now ? (
          <>
            <div className="flex items-center justify-between gap-[10px]">
              <span className="font-sans text-[12px] text-[#a9a9a9]">
                {max > 1 ? `Up to ${max} in one mint` : 'One per mint'}
              </span>
              <div className="flex items-center rounded-[6px] border border-[#2a2b30]" role="group" aria-label="Quantity">
                <button type="button" onClick={() => setQuantity((q) => Math.max(1, q - 1))} disabled={quantity <= 1} aria-label="One fewer" className="hit-44 h-[34px] w-[34px] font-sans text-[16px] text-white disabled:opacity-40">
                  -
                </button>
                <span className="w-[34px] text-center font-sans text-[14px] text-white" aria-live="polite">{quantity}</span>
                <button type="button" onClick={() => setQuantity((q) => Math.min(max, q + 1))} disabled={quantity >= max} aria-label="One more" className="hit-44 h-[34px] w-[34px] font-sans text-[16px] text-white disabled:opacity-40">
                  +
                </button>
              </div>
            </div>
            <button type="button" onClick={() => setSheet(true)} className="btn-sun h-[46px] rounded-[6px] font-sans text-[14px] font-semibold">
              {`Mint ${quantity} NFT${quantity > 1 ? 's' : ''}`}
            </button>
            <p className="m-0 font-sans text-[11px] text-[#8d8d8d]">
              Your wallet <span className="font-mono text-[#cfcfcf]">{shortAddr(v.wallet)}</span>
            </p>
          </>
        ) : null}

        {d.contractManaged ? (
          <p className="m-0 rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[10px] font-sans text-[11px] leading-[16px] text-[#a9a9a9]">
            Contract-managed. Flizy calls this collection&apos;s own mint function from your wallet. Its price, limits and schedule are
            set by the contract, not by Flizy, and Flizy takes no fee on this mint.
          </p>
        ) : null}
      </section>

      {/* Schedule */}
      {c ? (
        <section className="grid gap-[10px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[14px]" aria-label="Mint schedule">
          <h3 className="m-0 font-sans text-[13px] font-semibold text-white">Mint schedule</h3>
          <ol className="m-0 grid list-none gap-[10px] p-0">
            {scheduleSteps(c, now).map((s) => (
              <li key={s.key} className="flex items-start gap-[10px]">
                <span
                  className={`mt-[3px] h-[10px] w-[10px] shrink-0 rounded-full border ${
                    s.state === 'live' ? 'border-sun bg-sun' : s.state === 'done' ? 'border-[#6b6b6b] bg-[#6b6b6b]' : 'border-[#6b6b6b]'
                  }`}
                  aria-hidden
                />
                <span className="grid gap-[2px]">
                  <span className="font-sans text-[12.5px] text-white">
                    {s.title}
                    <span className="ml-[6px] text-[#a9a9a9]">{s.state === 'live' ? 'Live' : s.state === 'done' ? 'Ended' : ''}</span>
                  </span>
                  <span className="font-sans text-[11px] text-[#8d8d8d]">{s.when}</span>
                  {s.key === 'allowlist' ? (
                    <span className="font-sans text-[11px] text-[#8d8d8d]">
                      {BigInt(c.allowlistPriceWei) === 0n ? 'Free mint' : `${ethFromWei(c.allowlistPriceWei)} ETH`}, listed wallets only
                    </span>
                  ) : null}
                  {s.key === 'public' ? (
                    <span className="font-sans text-[11px] text-[#8d8d8d]">
                      {BigInt(c.publicPriceWei) === 0n ? 'Free mint' : `${ethFromWei(c.publicPriceWei)} ETH`}, up to {c.publicLimit} per wallet
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* About */}
      <section className="grid gap-[8px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[14px]" aria-label="About the collection">
        <h3 className="m-0 font-sans text-[13px] font-semibold text-white">About the collection</h3>
        {d.description ? <p className="m-0 font-sans text-[12.5px] leading-[18px] text-[#d6d6d6]">{d.description}</p> : null}
        <SheetRow label="Creator" value={d.creatorUsername ? `@${d.creatorUsername}` : d.contractManaged && d.verified ? 'Flizy' : 'Unknown'} />
        <SheetRow
          label="Contract"
          value={
            explorerBase ? (
              <a href={`${explorerBase}/address/${d.collection}`} target="_blank" rel="noreferrer noopener" className="font-mono text-white no-underline">
                {shortAddr(d.collection)}
              </a>
            ) : (
              <span className="font-mono">{shortAddr(d.collection)}</span>
            )
          }
        />
        <SheetRow label="Blockchain" value={network} />
        <SheetRow label="Creator royalty" value={d.royaltyBps ? bpsLabel(d.royaltyBps) : 'None'} />
        <SheetRow label="Flizy fee on this mint" value={d.contractManaged ? 'None' : free ? 'None (free mint)' : `${bpsLabel(d.feeBps)} of the mint price`} />
        <SheetRow
          label="Verified by Flizy"
          value={
            d.verified ? (
              <span className="inline-flex items-center gap-[5px] text-sun">
                <ShieldCheckIcon size={13} /> Yes
              </span>
            ) : (
              'Not verified'
            )
          }
        />
      </section>

      {sheet && v.now && total != null ? (
        <MintActionSheet
          title="Mint"
          subtitle={d.name}
          confirmLabel={`Confirm mint of ${quantity}`}
          url={`/api/mints/${d.collection}/mint`}
          body={{ quantity, priceWei: v.now.priceWei ?? '0' }}
          onClose={() => setSheet(false)}
          onDone={() => {
            load();
            onMinted?.();
          }}
        >
          <div className="grid gap-[7px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[12px]">
            <SheetRow label="Price each" value={free ? 'Free mint' : <EthAmount wei={price} />} />
            <SheetRow label="Quantity" value={quantity} />
            {!d.contractManaged && !free ? (
              <>
                <SheetRow label={`Flizy fee (${bpsLabel(d.feeBps)}, included)`} value={<EthAmount wei={fee} />} />
                <SheetRow label="Creator receives" value={<EthAmount wei={total - (fee ?? 0n)} />} />
              </>
            ) : null}
            <div className="my-[2px] h-px bg-[#23242a]" />
            <SheetRow label="You pay" value={free ? 'Nothing but network gas' : <EthAmount wei={total} />} strong />
            {!free && usdLabel(total, usdPerEth) ? (
              <p className="m-0 font-sans text-[10.5px] text-[#7d7d7d]">
                {usdLabel(total, usdPerEth)} at the mainnet ETH price. This is {network} testnet ETH.
              </p>
            ) : null}
          </div>
          <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
            {d.contractManaged
              ? 'Minted by the collection contract itself. Flizy adds no fee. Network gas is paid from your wallet.'
              : v.now.phase === 'allowlist'
                ? 'Allowlist mint. Your NFTs arrive in your Flizy wallet. Network gas is paid from your wallet.'
                : 'Public mint. Your NFTs arrive in your Flizy wallet. Network gas is paid from your wallet.'}
          </p>
        </MintActionSheet>
      ) : null}
    </div>
  );
}

/** "You're eligible", "Public mint isn't live yet", "Public mint is live", or why not. */
function Eligibility({ drop: d, viewer: v, now }: { drop: MintDrop; viewer: Viewer; now: number }) {
  const c = d.config;
  if (v.now?.phase === 'allowlist' && v.allowlist && c) {
    return (
      <div className="grid gap-[4px] rounded-[8px] border border-[#5a4a1c] bg-[#14120b] p-[11px]">
        <span className="inline-flex items-center gap-[6px] font-sans text-[13px] font-semibold text-sun">
          <CheckIcon size={13} strokeWidth={2.6} /> You&apos;re eligible
        </span>
        <span className="font-sans text-[12px] text-[#d6d6d6]">
          Allowlist: up to {v.allowlist.allowance} NFT{v.allowlist.allowance > 1 ? 's' : ''}
          {v.allowlist.minted ? `, ${v.allowlist.remaining} left` : ''}
        </span>
        <span className="inline-flex items-center gap-[5px] font-sans text-[11.5px] text-[#a9a9a9]">
          <ClockIcon size={12} /> Ends in {countdown(c.allowlistEnd, now)}
        </span>
      </div>
    );
  }
  if (v.now?.phase === 'public') {
    return (
      <div className="grid gap-[4px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[11px]">
        <span className="font-sans text-[13px] font-semibold text-white">Public mint is live</span>
        {v.public ? (
          <span className="font-sans text-[12px] text-[#a9a9a9]">
            {v.public.remaining} of {v.public.limit} left for your wallet
          </span>
        ) : null}
        {c?.mintEnd ? (
          <span className="inline-flex items-center gap-[5px] font-sans text-[11.5px] text-[#a9a9a9]">
            <ClockIcon size={12} /> Ends in {countdown(c.mintEnd, now)}
          </span>
        ) : null}
      </div>
    );
  }
  if (v.now?.phase === 'external') {
    return <p className="m-0 font-sans text-[12.5px] text-white">You can mint now.</p>;
  }
  if (d.status === 'upcoming' && c) {
    const allowlistFirst = c.allowlistStart !== 0 && c.allowlistStart > now;
    const opens = allowlistFirst ? c.allowlistStart : c.publicStart;
    return (
      <div className="grid gap-[4px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[11px]">
        <span className="font-sans text-[13px] font-semibold text-white">
          {allowlistFirst ? 'Allowlist mint is coming' : "Public mint isn't live yet"}
        </span>
        <span className="inline-flex items-center gap-[5px] font-sans text-[11.5px] text-[#a9a9a9]">
          <ClockIcon size={12} /> Starts in {countdown(opens, now)}
        </span>
      </div>
    );
  }
  if (d.allowlistLive && !d.publicLive && c?.publicStart && c.publicStart > now) {
    return (
      <div className="grid gap-[4px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[11px]">
        <span className="font-sans text-[13px] font-semibold text-white">Public mint isn&apos;t live yet</span>
        <span className="font-sans text-[12px] text-[#a9a9a9]">{v.reason}</span>
        <span className="inline-flex items-center gap-[5px] font-sans text-[11.5px] text-[#a9a9a9]">
          <ClockIcon size={12} /> Public starts in {countdown(c.publicStart, now)}
        </span>
      </div>
    );
  }
  return v.reason ? <p className="m-0 font-sans text-[12.5px] text-[#cfcfcf]">{v.reason}</p> : null;
}
