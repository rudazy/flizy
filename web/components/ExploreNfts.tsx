'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useDashboard } from './DashboardProvider';
import { ComingSoonPanel } from './ComingSoon';
import { CopySetupPanel } from './CopySetupPanel';
import { NFT_VIEWS, type NftViewId } from '../lib/tokenDiscovery';
import {
  BookOpenIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  EthDiamondIcon,
  MoreVerticalIcon,
  ShieldCheckIcon,
} from './ExploreIcons';

type Collection = {
  ticker: string;
  address: string;
  name: string;
  items: number | null;
  owners: number | null;
  freeMint: boolean;
};

/**
 * The tabs under NFTs. Listed and Copy Mint are the built views (NFT_VIEWS);
 * Trending, New and Top have no market behind them yet and say so.
 */
const [LISTED, COPY_MINT] = NFT_VIEWS;
const TABS = [
  LISTED,
  { id: 'trending', label: 'Trending' },
  { id: 'new', label: 'New' },
  { id: 'top', label: 'Top' },
  COPY_MINT,
] as const;

type TabId = NftViewId | 'trending' | 'new' | 'top';

/** Card artwork by ticker. A collection without one gets a drawn tile instead. */
const ARTWORK: Record<string, string> = {
  giwaforge: '/explore/nft-giwaforge.png',
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-5)}`;
}

function compact(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/**
 * NFT discovery, plus copy mint.
 *
 * The warning stays on the listed view. A collection someone does not hold is
 * still listed, because the address on this page is what a copy has to match.
 */
export function ExploreNfts() {
  const search = useSearchParams();
  const router = useRouter();
  const pathname = usePathname() || '';
  const raw = search.get('view');
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : 'listed';
  const { explorerBase } = useDashboard();
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState('');
  // The mint warning opens short; Read Guide shows it in full.
  const [guideOpen, setGuideOpen] = useState(false);

  useEffect(() => {
    if (tab !== 'listed') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/nfts');
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(body.error || 'Could not load collections.');
        else setCollections(Array.isArray(body.collections) ? body.collections : []);
      } catch {
        if (!cancelled) setError('Could not load collections.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  function setTab(next: TabId) {
    const params = new URLSearchParams(search.toString());
    params.set('s', 'nfts');
    if (next === 'listed') params.delete('view');
    else params.set('view', next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div className="!mt-[9px] grid w-full max-w-lg gap-[12px]">
      <div className="flex border-b border-[#2a2b30]" role="tablist" aria-label="NFT section">
        {TABS.map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.id)}
              className={`hit-y-44 relative -mb-px h-[27px] px-[13.5px] pb-[4px] font-sans text-[10px] ${
                active ? 'font-semibold text-sun' : 'text-[#bdbdbd] hover:text-white'
              }`}
            >
              {item.label}
              {active ? <span className="absolute inset-x-0 bottom-0 h-[2px] rounded-full bg-sun" aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      {tab === 'mint' ? <CopySetupPanel kind="mint" /> : null}
      {tab === 'trending' ? <ComingSoonPanel what="Trending collections" /> : null}
      {tab === 'new' ? <ComingSoonPanel what="New collections" /> : null}
      {tab === 'top' ? <ComingSoonPanel what="Top collections" /> : null}

      {tab === 'listed' ? (
        <>
          <section
            className="relative overflow-hidden rounded-[6px] border border-[#5a4a1c] pb-[14px] pl-[66px] pr-[27px] pt-[11px]"
            style={{ background: 'linear-gradient(135deg, #1a160c 0%, #14120b 45%, #100f0b 100%)' }}
          >
            <GuideSwirl />
            <ShieldCheckIcon size={33} strokeWidth={1.5} className="absolute left-[17px] top-[25px] text-sun" />
            <div className="relative -mr-[15.5px] flex items-center justify-between gap-[8px]">
              <h2 className="m-0 pt-[8px] font-sans text-[14px] font-bold text-white">Before you mint</h2>
              <button
                type="button"
                onClick={() => setGuideOpen((open) => !open)}
                aria-expanded={guideOpen}
                aria-controls="nft-mint-guide"
                className="hit-y-44 flex h-[25px] shrink-0 items-center gap-[9px] rounded-[5px] border border-sun px-[10px] font-sans text-[9.6px] font-medium text-sun"
              >
                <BookOpenIcon size={13} />
                {guideOpen ? 'Show less' : 'Read Guide'}
              </button>
            </div>
            {/* Short until opened: the first point, cut to two lines. Read Guide shows all of it. */}
            <div
              id="nft-mint-guide"
              className="relative mt-[5px] grid gap-[7px] font-sans text-[10.6px] leading-[14.5px] text-[#c9c9c9]"
            >
              <p className={`m-0 ${guideOpen ? '' : 'line-clamp-2'}`}>
                Anyone can deploy a collection using the same name and artwork as a real one. The name proves nothing.
                The contract address is the only thing that does.
              </p>
              {guideOpen ? (
                <>
                  <p className="m-0">
                    The collections below are the ones Flizy lists. If you find one anywhere else, compare its contract
                    address against this page before you mint or buy. If it does not match, it is a different
                    collection whatever it is called.
                  </p>
                  <p className="m-0">Flizy will never ask you to approve a contract in a direct message.</p>
                </>
              ) : null}
            </div>
          </section>

          <div className="mt-[14px] flex items-center justify-between gap-[10px]">
            <div className="min-w-0">
              <h2 className="m-0 font-sans text-[16px] font-bold text-white">Listed by Flizy</h2>
              <p className="m-0 mt-[2px] font-sans text-[9.8px] text-[#a9a9a9]">
                Official collections listed and verified by Flizy
              </p>
            </div>
            <Link
              href="/dashboard/explore/nfts"
              className="hit-y-44 flex h-[27px] shrink-0 items-center gap-[10px] rounded-[5px] border border-[#3a3b40] bg-[#0f0f10] px-[11px] font-sans text-[9.6px] text-[#ececec] no-underline hover:text-white"
            >
              View All
              <ChevronRightIcon size={11} />
            </Link>
          </div>

          {error ? <p className="alert alert-error m-0">{error}</p> : null}
          {collections === null && !error ? <p className="m-0 font-sans text-[10px] text-[#a9a9a9]">Loading...</p> : null}
          {collections && collections.length === 0 ? (
            <p className="m-0 font-sans text-[10px] text-[#a9a9a9]">No collections are listed on this network yet.</p>
          ) : null}
          {collections && collections.length > 0 ? (
            <div className="grid grid-cols-2 gap-[10px]">
              {collections.map((c) => (
                <CollectionCard
                  key={c.address}
                  collection={c}
                  explorerBase={explorerBase}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CollectionCard({
  collection,
  explorerBase,
}: {
  collection: Collection;
  explorerBase: string;
}) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const art = ARTWORK[collection.ticker];

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(collection.address);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
    setMenuOpen(false);
  }

  return (
    <article className="overflow-hidden rounded-[6px] border border-[#23242a] bg-[#0d0d0e]">
      <div className="relative h-[87px] bg-[#0b0b10]">
        {art ? (
          <Image src={art} alt={`${collection.name} artwork`} fill sizes="(max-width: 512px) 50vw, 240px" className="object-cover" />
        ) : (
          <div
            className="flex h-full items-center justify-center font-sans text-[30px] font-bold text-sun"
            style={{ background: 'radial-gradient(circle at 50% 60%, #2a2108 0%, #0d0b05 75%)' }}
            aria-hidden
          >
            {collection.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <span className="absolute left-[8px] top-[8px] flex h-[20px] items-center gap-[5px] rounded-full border border-[#3a3b40] bg-[#0b0b0c]/85 pl-[4px] pr-[8px] font-sans text-[8px] text-sun">
          <span className="flex h-[11px] w-[11px] items-center justify-center rounded-full bg-sun text-[#1a1405]">
            <CheckIcon size={8} strokeWidth={3} />
          </span>
          Verified
        </span>
        {/* Positioned by a wrapper: .hit-44 sets position: relative on the button itself. */}
        <span className="absolute right-[8px] top-[8px]">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={`${collection.name} options`}
            aria-expanded={menuOpen}
            className="hit-44 flex h-[20px] w-[20px] items-center justify-center rounded-full bg-[#0b0b0c]/85 text-white"
          >
            <MoreVerticalIcon size={12} />
          </button>
        </span>
        {menuOpen ? (
          <div className="absolute right-[8px] top-[31px] z-10 grid min-w-[118px] rounded-[5px] border border-[#2a2b30] bg-[#111113] py-[3px] shadow-lg">
            <MenuItem onClick={copyAddress}>Copy address</MenuItem>
            {explorerBase ? (
              <a
                href={`${explorerBase}/address/${collection.address}`}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() => setMenuOpen(false)}
                className="px-[10px] py-[6px] font-sans text-[9.5px] text-[#e6e6e6] no-underline hover:bg-[#1a1a1d] hover:text-white"
              >
                View on explorer
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="px-[9px] pb-[8px] pt-[7px]">
        <h3 className="m-0 truncate font-sans text-[12px] font-semibold text-white">{collection.name}</h3>
        <button
          type="button"
          onClick={copyAddress}
          aria-label={`Copy ${collection.name} contract address`}
          title={collection.address}
          className="mt-[3px] flex items-center gap-[6px] font-mono text-[8px] text-[#bdbdbd] hover:text-white"
        >
          {copied ? 'Copied' : shortAddress(collection.address)}
          <CopyIcon size={9} />
        </button>
        <div className="mt-[9px] grid grid-cols-[1fr_1fr_1.25fr]">
          <Stat value={compact(collection.items)} label="Items" />
          <Stat value={compact(collection.owners)} label="Owners" divider />
          <Stat
            value={
              collection.freeMint ? (
                <span className="flex items-center gap-[3px]">
                  <EthDiamondIcon size={10} className="text-[#8c8fe8]" />
                  Free
                </span>
              ) : (
                '-'
              )
            }
            label="Mint price"
            divider
          />
        </div>
        <Link
          href={`/dashboard/explore/nfts/${collection.address}`}
          className="btn-sun mt-[9px] h-[25.5px] w-full justify-between rounded-[5px] px-[12px] font-sans text-[9.6px] font-medium no-underline"
        >
          <span className="flex-1 text-center">View Collection</span>
          <ChevronRightIcon size={11} strokeWidth={2.2} />
        </Link>
      </div>
    </article>
  );
}

function Stat({ value, label, divider = false }: { value: ReactNode; label: string; divider?: boolean }) {
  return (
    <div className={`min-w-0 ${divider ? 'border-l border-[#2a2b30] pl-[8px]' : ''}`}>
      <span className="block font-sans text-[10.5px] font-semibold text-white">{value}</span>
      <span className="mt-[1px] block truncate font-sans text-[8px] text-[#a9a9a9]">{label}</span>
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-[10px] py-[6px] text-left font-sans text-[9.5px] text-[#e6e6e6] hover:bg-[#1a1a1d] hover:text-white"
    >
      {children}
    </button>
  );
}

/** Faint gold lines on the left of the warning card. Decoration only. */
function GuideSwirl() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 h-full w-[70px]"
      viewBox="0 0 70 220"
      preserveAspectRatio="none"
      fill="none"
    >
      <path d="M-10 60 C 40 90, 60 150, 30 230" stroke="#f7d047" strokeOpacity="0.18" strokeWidth="1" />
      <path d="M-14 74 C 34 104, 52 160, 22 230" stroke="#f7d047" strokeOpacity="0.12" strokeWidth="1" />
      <path d="M-18 88 C 28 118, 44 170, 14 230" stroke="#f7d047" strokeOpacity="0.08" strokeWidth="1" />
    </svg>
  );
}
