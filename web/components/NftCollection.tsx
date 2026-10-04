'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeftIcon,
  CartIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  EthDiamondIcon,
  ExternalLinkIcon,
  FilterIcon,
  GlobeIcon,
  GridIcon,
  HeartIcon,
  ListIcon,
  MoreVerticalIcon,
  SearchIcon,
  SortIcon,
  TagIcon,
} from './ExploreIcons';
import { NftTradeSheet, type TradeIntent } from './NftTradeSheet';
import { MintPanel, MintStatusPill, type MintDrop } from './MintPanel';
import { FloorChartSheet, FloorSparkline, type SalePoint } from './NftFloorChart';
import { bpsLabel, compactCount, ethFromWei, monthYear, shortAddr, timeAgo, usdLabel } from '../lib/nftFormat';
import { isLiveStatus } from '../lib/mintFormat';

type Header = {
  address: string;
  name: string;
  symbol: string | null;
  standard: 'ERC-721' | 'ERC-1155';
  holders: number | null;
  supply: string | null;
  icon: string | null;
  verified: boolean;
  ticker: string | null;
  profile: { description: string; banner: string | null; avatar: string | null; creator: string; category: string | null } | null;
  creator: string | null;
  createdAt: string | null;
  maxSupply: string | null;
  freeMint: boolean;
  contractOwner: string | null;
};

type CollectionData = {
  collection: Header;
  market: {
    enabled: boolean;
    address: string | null;
    paused: boolean;
    tradable: boolean;
    feeBps: number;
    royaltyBps: number;
    royaltyReceiver: string | null;
    stats: {
      floorWei: string | null;
      volumeWei: string;
      salesCount: number;
      listedCount: number;
      bestOfferWei: string | null;
      series: SalePoint[];
    } | null;
  };
  usdPerEth: number | null;
  explorerBaseUrl: string;
  network: string;
};

type NftCardData = {
  collection: string;
  tokenId: string;
  name: string;
  image: string | null;
  owner: string | null;
  priceWei: string | null;
  seller: string | null;
  expiry: number | null;
  listedAt: string | null;
  traits: Array<{ trait: string; value: string }>;
};

type ItemsData = { listed: NftCardData[]; items: NftCardData[]; next: string | null; viewer: string };

const TABS = [
  { id: 'items', label: 'Items' },
  { id: 'activity', label: 'Activity' },
  { id: 'holders', label: 'Holders' },
  { id: 'traits', label: 'Traits' },
  { id: 'about', label: 'About' },
] as const;
/** Shown after Items while the collection mints through Flizy. */
const MINT_TAB = { id: 'mint', label: 'Mint' } as const;
type TabId = (typeof TABS)[number]['id'] | typeof MINT_TAB.id;

const FILTERS = [
  { id: 'all', label: 'All items' },
  { id: 'listed', label: 'Listed' },
  { id: 'mine', label: 'My items' },
] as const;
const SORTS = [
  { id: 'price_asc', label: 'Price: Low to High' },
  { id: 'price_desc', label: 'Price: High to Low' },
  { id: 'recent', label: 'Recently listed' },
  { id: 'id', label: 'Token ID' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];
type SortId = (typeof SORTS)[number]['id'];

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load this.');
  return body as T;
}

function itemHref(collection: string, tokenId: string) {
  return `/dashboard/explore/nfts/${collection}/${tokenId}`;
}

/** Price in ETH with the diamond, and the USD line under it when there is a rate. */
export function PriceBlock({
  wei,
  usdPerEth,
  size = 'md',
}: {
  wei: string | null;
  usdPerEth: number | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const eth = ethFromWei(wei);
  const usd = usdLabel(wei, usdPerEth);
  const text = size === 'lg' ? 'text-[19px]' : size === 'md' ? 'text-[13.5px]' : 'text-[12px]';
  return (
    <span className="block min-w-0">
      <span className={`flex items-center gap-[5px] font-sans font-semibold text-white ${text}`}>
        <EthDiamondIcon size={size === 'lg' ? 15 : 12} className="shrink-0 text-[#cfcfcf]" />
        <span className="truncate">{eth == null ? '-' : `${eth}${size === 'lg' ? '' : ' ETH'}`}</span>
      </span>
      {usd ? <span className="mt-[1px] block font-sans text-[11px] text-[#9a9a9a]">{usd}</span> : null}
    </span>
  );
}

/** Art for a card or header. Tokens without art get a drawn tile with the collection initial. */
export function NftArt({ src, alt, initial, className }: { src: string | null; alt: string; initial: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div
        className={`flex items-center justify-center font-sans font-bold text-sun ${className || ''}`}
        style={{ background: 'radial-gradient(circle at 50% 60%, #2a2108 0%, #0d0b05 75%)' }}
        role="img"
        aria-label={alt}
      >
        <span className="text-[28px]">{initial.slice(0, 1).toUpperCase()}</span>
      </div>
    );
  }
  return (
    // External NFT art: hosts are unknown ahead of time, so next/image cannot be configured for them.
    <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={`object-cover ${className || ''}`} />
  );
}

function VerifiedBadge({ size = 16 }: { size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-sun text-[#1a1405]" style={{ width: size, height: size }} title="Verified by Flizy">
      <CheckIcon size={size * 0.62} strokeWidth={3} />
      <span className="sr-only">Verified by Flizy</span>
    </span>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[28px] shrink-0 items-center rounded-full border border-[#2c2d33] px-[12px] font-sans text-[12px] text-[#e2e2e2]">
      {children}
    </span>
  );
}

function Menu<T extends string>({
  options,
  value,
  onPick,
  onClose,
  align = 'left',
}: {
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onPick: (id: T) => void;
  onClose: () => void;
  align?: 'left' | 'right';
}) {
  useEffect(() => {
    const close = () => onClose();
    const t = setTimeout(() => window.addEventListener('click', close), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('click', close);
    };
  }, [onClose]);
  return (
    <div
      role="listbox"
      className={`absolute top-[calc(100%+6px)] z-30 grid min-w-[178px] rounded-[8px] border border-[#2a2b30] bg-[#121214] py-[4px] shadow-xl ${
        align === 'right' ? 'right-0' : 'left-0'
      }`}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="option"
          aria-selected={o.id === value}
          onClick={() => onPick(o.id)}
          className={`flex items-center justify-between gap-3 px-[12px] py-[9px] text-left font-sans text-[12.5px] hover:bg-[#1b1b1e] ${
            o.id === value ? 'text-sun' : 'text-[#e6e6e6]'
          }`}
        >
          {o.label}
          {o.id === value ? <CheckIcon size={12} /> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * One collection: header, figures, and the Items, Activity, Holders, Traits
 * and About tabs. Prices and history come from the Flizy marketplace;
 * ownership and supply from the chain; art and holders from the explorer.
 */
export function NftCollection({ address }: { address: string }) {
  const router = useRouter();
  const pathname = usePathname() || '';
  const search = useSearchParams();
  const rawTab = search.get('tab');
  const tab: TabId = TABS.some((t) => t.id === rawTab) || rawTab === MINT_TAB.id ? (rawTab as TabId) : 'items';

  const [data, setData] = useState<CollectionData | null>(null);
  // The drop, when this collection mints through Flizy; null when it does not.
  const [mintDrop, setMintDrop] = useState<MintDrop | null>(null);
  const mintTab = {
    id: MINT_TAB.id,
    label: mintDrop && (mintDrop.status === 'ended' || mintDrop.status === 'sold_out') ? 'Mint ended' : MINT_TAB.label,
  };
  const [error, setError] = useState('');
  const [items, setItems] = useState<ItemsData | null>(null);
  const [itemsError, setItemsError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<FilterId>('all');
  const [sort, setSort] = useState<SortId>('price_asc');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [openMenu, setOpenMenu] = useState<'filter' | 'sort' | 'more' | null>(null);
  const [descOpen, setDescOpen] = useState(false);
  const [intent, setIntent] = useState<TradeIntent | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [compact, setCompact] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const loadHeader = useCallback(async () => {
    try {
      setData(await getJson<CollectionData>(`/api/nfts/collections/${address}`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this collection.');
    }
  }, [address]);

  const loadItems = useCallback(
    async (cursor: string | null) => {
      const params = new URLSearchParams({ filter, sort });
      if (debounced) params.set('q', debounced);
      if (cursor) params.set('cursor', cursor);
      try {
        const page = await getJson<ItemsData>(`/api/nfts/collections/${address}/items?${params.toString()}`);
        setItems((prev) =>
          cursor && prev ? { ...page, listed: prev.listed, items: [...prev.items, ...page.items] } : page
        );
        setItemsError('');
      } catch (e) {
        setItemsError(e instanceof Error ? e.message : 'Could not load items.');
      }
    },
    [address, filter, sort, debounced]
  );

  useEffect(() => {
    loadHeader();
  }, [loadHeader]);

  const loadMint = useCallback(async () => {
    try {
      const res = await fetch(`/api/mints/${address}`);
      const body = await res.json().catch(() => ({}));
      setMintDrop(res.ok && body.drop ? (body.drop as MintDrop) : null);
    } catch {
      setMintDrop(null);
    }
  }, [address]);

  useEffect(() => {
    loadMint();
  }, [loadMint]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setItems(null);
    loadItems(null);
  }, [loadItems]);

  useEffect(() => {
    let cancelled = false;
    getJson<{ favorites: Array<{ collection: string; tokenId: string }> }>(`/api/nfts/favorites?collection=${address}`)
      .then((r) => {
        if (!cancelled) setFavorites(new Set(r.favorites.map((f) => f.tokenId)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [address]);

  // The header shrinks to the compact form once the name scrolls under it.
  useEffect(() => {
    const el = nameRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setCompact(!entry.isIntersecting), { rootMargin: '-60px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [data]);

  function setTab(next: TabId) {
    const params = new URLSearchParams(search.toString());
    if (next === 'items') params.delete('tab');
    else params.set('tab', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  async function toggleFavorite(tokenId: string) {
    const on = !favorites.has(tokenId);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (on) next.add(tokenId);
      else next.delete(tokenId);
      return next;
    });
    const res = await fetch('/api/nfts/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: address, tokenId, on }),
    }).catch(() => null);
    if (!res || !res.ok) {
      setFavorites((prev) => {
        const next = new Set(prev);
        if (on) next.delete(tokenId);
        else next.add(tokenId);
        return next;
      });
    }
  }

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const refreshAfterTrade = useCallback(() => {
    loadHeader();
    loadItems(null);
  }, [loadHeader, loadItems]);

  const viewer = items?.viewer ?? null;
  const floorListing = useMemo(() => {
    const listed = (items?.listed ?? []).filter((c) => c.priceWei && c.seller !== viewer);
    return listed.sort((a, b) => (BigInt(a.priceWei!) < BigInt(b.priceWei!) ? -1 : 1))[0] ?? null;
  }, [items, viewer]);

  if (error && !data) {
    return (
      <div className="grid gap-3 pt-6">
        <BackBar />
        <p className="alert alert-error m-0">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid gap-3 pt-6">
        <BackBar />
        <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">Loading collection...</p>
      </div>
    );
  }

  const c = data.collection;
  const m = data.market;
  const stats = m.stats;
  const usd = data.usdPerEth;
  const avatar = c.profile?.avatar ?? c.icon;
  const banner = c.profile?.banner ?? null;
  const supply = c.supply ? Number(c.supply) : null;
  const ownersShare = c.holders != null && supply ? `${((c.holders / supply) * 100).toFixed(1)}%` : null;
  const description =
    c.profile?.description ??
    `${c.name} is a ${c.standard} collection on ${data.network}. Flizy has not verified it: check the contract address before you trade. NFTs from it can be traded here but cannot be sent in chat.`;
  const itemsLabel = c.maxSupply && c.supply ? `${compactCount(c.supply)} / ${compactCount(c.maxSupply)} minted` : `${compactCount(c.supply)} items`;
  const visible = [...(items?.listed ?? []), ...(items?.items ?? [])];
  const featured = (items?.listed.length ? items.listed : items?.items ?? []).slice(0, 6);
  const isCreator = viewer != null && c.contractOwner === viewer;

  function cardAction(card: NftCardData): { label: string; icon: ReactNode; run: () => void } | null {
    if (!m.tradable) return null;
    const mine = viewer != null && card.owner === viewer;
    if (card.priceWei && card.seller !== viewer && !mine) {
      return {
        label: 'Buy',
        icon: <CartIcon size={15} />,
        run: () => setIntent({ action: 'buy', collection: address, tokenId: card.tokenId, name: card.name, priceWei: card.priceWei! }),
      };
    }
    if (mine) {
      return {
        label: card.priceWei ? 'Edit' : 'List',
        icon: <TagIcon size={14} />,
        run: () => setIntent({ action: 'list', collection: address, tokenId: card.tokenId, name: card.name, currentWei: card.priceWei }),
      };
    }
    return {
      label: 'Offer',
      icon: <TagIcon size={14} />,
      run: () => setIntent({ action: 'offer', collection: address, tokenId: card.tokenId, name: card.name }),
    };
  }

  return (
    <div className="relative -mt-4 w-full min-w-0 pb-[calc(var(--app-nav-clearance)+64px)] md:pb-24">
      {/* Top bar: the full title over the banner, the collection once scrolled. */}
      <header className="sticky top-0 z-40 -mx-4 flex h-[60px] items-center gap-[10px] bg-ink/90 px-4 backdrop-blur-md sm:-mx-6 sm:px-6">
        <BackButton />
        <div className="min-w-0 flex-1">
          {compact ? (
            <div className="flex min-w-0 items-center gap-[10px]">
              <NftArt src={avatar} alt="" initial={c.name} className="h-[34px] w-[34px] shrink-0 rounded-[8px]" />
              <div className="min-w-0">
                <p className="m-0 flex items-center gap-[6px] truncate font-sans text-[14.5px] font-semibold text-white">
                  <span className="truncate">{c.name}</span>
                  {c.verified ? <VerifiedBadge size={14} /> : null}
                </p>
                <p className="m-0 font-sans text-[11.5px] text-[#a9a9a9]">{itemsLabel}</p>
              </div>
            </div>
          ) : (
            <h1 className="m-0 truncate font-sans text-[17px] font-semibold text-white">Flizy NFTs</h1>
          )}
        </div>
        <button
          type="button"
          aria-label="Search items"
          onClick={() => {
            setTab('items');
            setTimeout(() => {
              searchRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              searchRef.current?.focus();
            }, 50);
          }}
          className="hit-44 flex h-[38px] w-[38px] items-center justify-center rounded-full bg-[#141416] text-white"
        >
          <SearchIcon size={18} />
        </button>
        <span className="relative">
          <button
            type="button"
            aria-label="Collection options"
            aria-expanded={openMenu === 'more'}
            onClick={(e) => {
              e.stopPropagation();
              setOpenMenu(openMenu === 'more' ? null : 'more');
            }}
            className="hit-44 flex h-[38px] w-[38px] items-center justify-center rounded-full bg-[#141416] text-white"
          >
            <MoreVerticalIcon size={17} />
          </button>
          {openMenu === 'more' ? (
            <div className="absolute right-0 top-[calc(100%+6px)] z-30 grid min-w-[190px] rounded-[8px] border border-[#2a2b30] bg-[#121214] py-[4px] shadow-xl">
              <button type="button" onClick={copyAddress} className="flex items-center gap-[10px] px-[12px] py-[9px] text-left font-sans text-[12.5px] text-[#e6e6e6] hover:bg-[#1b1b1e]">
                <CopyIcon size={13} /> {copied ? 'Copied' : 'Copy contract address'}
              </button>
              <a
                href={`${data.explorerBaseUrl}/token/${address}`}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-[10px] px-[12px] py-[9px] font-sans text-[12.5px] text-[#e6e6e6] no-underline hover:bg-[#1b1b1e]"
              >
                <ExternalLinkIcon size={13} /> View on explorer
              </a>
            </div>
          ) : null}
        </span>
      </header>

      {/* Banner and avatar */}
      <div className="relative -mx-4 sm:mx-0">
        <div className="relative h-[168px] overflow-hidden sm:rounded-[10px]">
          {banner ? (
            <NftArt src={banner} alt={`${c.name} banner`} initial={c.name} className="h-full w-full" />
          ) : (
            <div className="h-full w-full" style={{ background: 'linear-gradient(135deg, #1a160c 0%, #100f0b 60%, #0b0a09 100%)' }} aria-hidden />
          )}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[70px] bg-gradient-to-t from-ink to-transparent" aria-hidden />
        </div>
        <div className="absolute -bottom-[34px] left-4 sm:left-0">
          <NftArt src={avatar} alt={`${c.name} avatar`} initial={c.name} className="h-[88px] w-[88px] rounded-[14px] border-[3px] border-ink" />
        </div>
      </div>

      {/* Name, creator, links */}
      <div ref={nameRef} className="mt-[44px] flex items-start justify-between gap-[12px]">
        <div className="min-w-0">
          <h2 className="m-0 flex items-center gap-[8px] font-sans text-[22px] font-bold leading-tight text-white">
            <span className="truncate">{c.name}</span>
            {c.verified ? <VerifiedBadge size={18} /> : null}
          </h2>
          <p className="m-0 mt-[5px] flex items-center gap-[6px] font-sans text-[13px] text-[#cfcfcf]">
            By{' '}
            {c.profile ? (
              <span className="font-medium text-white">{c.profile.creator}</span>
            ) : c.creator ? (
              <a href={`${data.explorerBaseUrl}/address/${c.creator}`} target="_blank" rel="noreferrer noopener" className="font-medium text-white no-underline">
                {shortAddr(c.creator)}
              </a>
            ) : (
              <span className="text-[#a9a9a9]">unknown</span>
            )}
            {c.verified ? <VerifiedBadge size={13} /> : null}
          </p>
          {!c.verified ? (
            <span className="mt-[7px] inline-flex h-[22px] items-center rounded-full border border-[#5a4a1c] px-[9px] font-sans text-[11px] text-sun">
              Not verified by Flizy
            </span>
          ) : null}
          {mintDrop ? (
            <span className="ml-[6px] mt-[7px] inline-flex">
              <MintStatusPill status={mintDrop.status} contractManaged={mintDrop.contractManaged} />
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-[8px]">
          <a
            href={`${data.explorerBaseUrl}/token/${address}`}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open on the explorer"
            className="hit-44 flex h-[38px] w-[38px] items-center justify-center rounded-full border border-[#2c2d33] text-white"
          >
            <GlobeIcon size={17} />
          </a>
          <button
            type="button"
            onClick={copyAddress}
            aria-label="Copy contract address"
            className="hit-44 flex h-[38px] w-[38px] items-center justify-center rounded-full border border-[#2c2d33] text-white"
          >
            {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          </button>
        </div>
      </div>

      {/* Chips */}
      <div className="mt-[14px] flex gap-[7px] overflow-x-auto pb-[2px] [scrollbar-width:none]">
        <Chip>{c.profile?.category ?? c.standard}</Chip>
        <Chip>{itemsLabel}</Chip>
        <Chip>{data.network}</Chip>
        {monthYear(c.createdAt) ? <Chip>{monthYear(c.createdAt)}</Chip> : null}
        <Chip>{m.enabled ? (m.royaltyBps ? `${bpsLabel(m.royaltyBps)} Royalties` : 'No royalties') : 'Royalties: n/a'}</Chip>
      </div>

      {/* Description */}
      <p className={`m-0 mt-[14px] font-sans text-[13px] leading-[19px] text-[#d6d6d6] ${descOpen ? '' : 'line-clamp-2'}`}>{description}</p>
      <button type="button" onClick={() => setDescOpen((o) => !o)} aria-expanded={descOpen} className="mt-[6px] flex items-center gap-[6px] font-sans text-[12.5px] text-[#cfcfcf]">
        {descOpen ? 'Show less' : 'Read more'}
        <ChevronDownIcon size={13} className={descOpen ? 'rotate-180' : ''} />
      </button>

      {/* Mint, while it is running or about to */}
      {mintDrop && (isLiveStatus(mintDrop.status) || mintDrop.status === 'upcoming') && tab !== 'mint' ? (
        <button
          type="button"
          onClick={() => setTab('mint')}
          className="mt-[16px] flex w-full items-center justify-between gap-[12px] rounded-[12px] border border-[#5a4a1c] bg-[#14120b] px-[14px] py-[12px] text-left"
        >
          <span className="grid gap-[2px]">
            <span className="font-sans text-[10.5px] font-semibold uppercase tracking-wide text-sun">Mint</span>
            <span className="font-sans text-[16px] font-bold text-white">
              {mintDrop.priceWei == null ? 'Price set by the contract' : mintDrop.priceWei === '0' ? 'Free mint' : `${ethFromWei(mintDrop.priceWei)} ETH`}
            </span>
            <span className="font-sans text-[11px] text-[#a9a9a9]">
              {mintDrop.minted.toLocaleString('en-US')}
              {mintDrop.maxSupply ? ` / ${mintDrop.maxSupply.toLocaleString('en-US')}` : ''} minted
            </span>
          </span>
          <span className="btn-sun inline-flex h-[36px] items-center gap-[6px] rounded-[6px] px-[14px] font-sans text-[12.5px] font-semibold">
            {isLiveStatus(mintDrop.status) ? 'Mint' : 'See mint'} <ChevronRightIcon size={12} />
          </span>
        </button>
      ) : null}

      {/* Figures */}
      <section className="mt-[16px] grid grid-cols-3 rounded-[12px] border border-[#23242a] bg-[#0d0d0e] py-[14px]" aria-label="Collection figures">
        <Figure label="Floor price">
          {stats?.floorWei ? <PriceBlock wei={stats.floorWei} usdPerEth={usd} size="lg" /> : <Empty>{m.enabled ? 'No listings' : 'Not live'}</Empty>}
        </Figure>
        <Figure label="Total volume" divider>
          {m.enabled ? (
            <span className="block">
              <span className="block font-sans text-[19px] font-semibold text-white">
                {ethFromWei(stats?.volumeWei ?? '0')} <span className="text-[14px] font-medium">ETH</span>
              </span>
              {usdLabel(stats?.volumeWei ?? '0', usd) ? (
                <span className="mt-[1px] block font-sans text-[11px] text-[#9a9a9a]">{usdLabel(stats?.volumeWei ?? '0', usd)}</span>
              ) : null}
            </span>
          ) : (
            <Empty>Not live</Empty>
          )}
        </Figure>
        <Figure label="Owners" divider>
          <span className="block font-sans text-[19px] font-semibold text-white">{compactCount(c.holders)}</span>
          {ownersShare ? <span className="mt-[1px] block font-sans text-[11px] text-[#9a9a9a]">({ownersShare})</span> : null}
        </Figure>
      </section>

      {/* Tabs */}
      <div className="mt-[18px] flex overflow-x-auto border-b border-[#23242a] [scrollbar-width:none]" role="tablist" aria-label="Collection sections">
        {(mintDrop ? [TABS[0], mintTab, ...TABS.slice(1)] : TABS).map((t) => (
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

      {tab === 'mint' ? (
        <div className="mt-[14px]">
          <MintPanel
            collection={address}
            onMinted={() => {
              loadMint();
              loadHeader();
              loadItems(null);
            }}
          />
        </div>
      ) : null}

      {tab === 'items' ? (
        // minmax(0,1fr): an auto column would widen to the Featured row's full scroll width.
        <div className="mt-[14px] grid grid-cols-[minmax(0,1fr)] gap-[14px]">
          {/* Search row */}
          <div className="flex items-center gap-[8px]">
            <span className="relative">
              <button
                type="button"
                aria-label="Filter items"
                aria-expanded={openMenu === 'filter'}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(openMenu === 'filter' ? null : 'filter');
                }}
                className={`hit-44 flex h-[42px] w-[42px] items-center justify-center rounded-[10px] border ${filter !== 'all' ? 'border-sun text-sun' : 'border-[#2a2b30] text-white'}`}
              >
                <FilterIcon size={17} />
              </button>
              {openMenu === 'filter' ? (
                <Menu options={FILTERS} value={filter} onPick={(id) => { setFilter(id); setOpenMenu(null); }} onClose={() => setOpenMenu(null)} />
              ) : null}
            </span>
            <label className="flex h-[42px] min-w-0 flex-1 items-center gap-[8px] rounded-[10px] border border-[#2a2b30] bg-[#0d0d0e] px-[12px]">
              <SearchIcon size={16} className="shrink-0 text-[#9a9a9a]" />
              <span className="sr-only">Search by number, name or trait</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name or trait..."
                className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-white outline-none placeholder:text-[#7d7d7d]"
              />
            </label>
            <span className="relative">
              <button
                type="button"
                aria-label="Sort items"
                aria-expanded={openMenu === 'sort'}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(openMenu === 'sort' ? null : 'sort');
                }}
                className="hit-44 flex h-[42px] w-[42px] items-center justify-center rounded-[10px] border border-[#2a2b30] text-white"
              >
                <SortIcon size={17} />
              </button>
              {openMenu === 'sort' ? (
                <Menu options={SORTS} value={sort} align="right" onPick={(id) => { setSort(id); setOpenMenu(null); }} onClose={() => setOpenMenu(null)} />
              ) : null}
            </span>
          </div>

          {/* Live floor */}
          <section className="flex items-center gap-[12px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] px-[14px] py-[12px]">
            <div className="min-w-0">
              <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">Live floor</p>
              {stats?.floorWei ? (
                <div className="mt-[3px]">
                  <PriceBlock wei={stats.floorWei} usdPerEth={usd} />
                </div>
              ) : (
                <p className="m-0 mt-[3px] font-sans text-[13px] font-semibold text-white">{m.enabled ? 'No listings yet' : 'Trading not live'}</p>
              )}
            </div>
            <div className="ml-auto flex min-w-0 items-center gap-[12px]">
              <span className="hidden min-[380px]:block">
                <FloorSparkline points={stats?.series ?? []} width={118} />
              </span>
              <button type="button" onClick={() => setChartOpen(true)} className="h-[32px] shrink-0 rounded-full border border-[#3a3b40] px-[12px] font-sans text-[12px] text-sun">
                View chart
              </button>
            </div>
          </section>

          {/* Featured */}
          {featured.length && !debounced && filter === 'all' ? (
            <section aria-label="Featured">
              <h3 className="m-0 font-sans text-[17px] font-bold text-white">Featured</h3>
              <div className="-mx-4 mt-[10px] flex gap-[10px] overflow-x-auto px-4 pb-[4px] [scrollbar-width:none] sm:mx-0 sm:px-0">
                {featured.map((card) => (
                  <Link key={card.tokenId} href={itemHref(address, card.tokenId)} className="relative w-[150px] shrink-0 overflow-hidden rounded-[12px] border border-[#23242a] bg-[#0d0d0e] no-underline">
                    <NftArt src={card.image} alt={card.name} initial={c.name} className="aspect-square w-full" />
                    <div className="px-[10px] pb-[10px] pt-[8px]">
                      <p className="m-0 truncate font-sans text-[13px] font-medium text-white">{card.name}</p>
                      <div className="mt-[3px]">
                        {card.priceWei ? <PriceBlock wei={card.priceWei} usdPerEth={null} size="sm" /> : <span className="font-sans text-[12px] text-[#9a9a9a]">Not listed</span>}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}

          {/* Filter, sort, layout */}
          <div className="flex items-center gap-[8px]">
            <span className="relative">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(openMenu === 'filter' ? null : 'filter');
                }}
                className="flex h-[36px] items-center gap-[8px] rounded-[9px] border border-[#2a2b30] px-[12px] font-sans text-[12.5px] text-white"
              >
                {FILTERS.find((f) => f.id === filter)?.label}
                <ChevronDownIcon size={13} />
              </button>
            </span>
            <span className="relative min-w-0">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenu(openMenu === 'sort' ? null : 'sort');
                }}
                className="flex h-[36px] min-w-0 items-center gap-[8px] rounded-[9px] border border-[#2a2b30] px-[12px] font-sans text-[12.5px] text-white"
              >
                <span className="truncate">{SORTS.find((s) => s.id === sort)?.label}</span>
                <ChevronDownIcon size={13} className="shrink-0" />
              </button>
            </span>
            <button
              type="button"
              aria-label={layout === 'grid' ? 'Show as list' : 'Show as grid'}
              onClick={() => setLayout(layout === 'grid' ? 'list' : 'grid')}
              className="ml-auto flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-[9px] bg-sun text-[#1a1405]"
            >
              {layout === 'grid' ? <GridIcon size={17} /> : <ListIcon size={17} />}
            </button>
          </div>

          {itemsError ? <p className="alert alert-error m-0">{itemsError}</p> : null}
          {!items && !itemsError ? <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">Loading items...</p> : null}
          {items && visible.length === 0 ? (
            <p className="m-0 rounded-[10px] border border-[#23242a] bg-[#0d0d0e] p-[16px] font-sans text-[12.5px] text-[#a9a9a9]">
              {filter === 'mine' ? 'You hold none from this collection.' : filter === 'listed' ? 'Nothing is listed yet.' : 'No items match.'}
            </p>
          ) : null}

          {layout === 'grid' ? (
            <div className="grid grid-cols-2 gap-[10px]">
              {visible.map((card) => (
                <ItemCard
                  key={card.tokenId}
                  card={card}
                  collectionName={c.name}
                  usdPerEth={usd}
                  favorite={favorites.has(card.tokenId)}
                  onFavorite={() => toggleFavorite(card.tokenId)}
                  action={cardAction(card)}
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-[8px]">
              {visible.map((card) => {
                const action = cardAction(card);
                return (
                  <div key={card.tokenId} className="flex items-center gap-[12px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[8px]">
                    <Link href={itemHref(address, card.tokenId)} className="flex min-w-0 flex-1 items-center gap-[12px] no-underline">
                      <NftArt src={card.image} alt={card.name} initial={c.name} className="h-[58px] w-[58px] shrink-0 rounded-[9px]" />
                      <div className="min-w-0">
                        <p className="m-0 truncate font-sans text-[13.5px] font-medium text-white">{card.name}</p>
                        <div className="mt-[3px]">
                          {card.priceWei ? <PriceBlock wei={card.priceWei} usdPerEth={usd} size="sm" /> : <span className="font-sans text-[12px] text-[#9a9a9a]">Not listed</span>}
                        </div>
                      </div>
                    </Link>
                    {action ? (
                      <button type="button" onClick={action.run} className="btn-sun h-[34px] shrink-0 gap-[6px] rounded-[8px] px-[12px] font-sans text-[12.5px]">
                        {action.icon}
                        {action.label}
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {items?.next ? (
            <button
              type="button"
              disabled={loadingMore}
              onClick={async () => {
                setLoadingMore(true);
                await loadItems(items.next);
                setLoadingMore(false);
              }}
              className="h-[40px] rounded-[9px] border border-[#2a2b30] font-sans text-[12.5px] text-white disabled:opacity-60"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          ) : null}
        </div>
      ) : null}

      {tab === 'activity' ? <ActivityTab address={address} usdPerEth={usd} /> : null}
      {tab === 'holders' ? <HoldersTab address={address} viewer={viewer} /> : null}
      {tab === 'traits' ? <TraitsTab address={address} onPick={(value) => { setQuery(value); setTab('items'); }} /> : null}
      {tab === 'about' ? (
        <AboutTab
          data={data}
          isCreator={isCreator}
          onRoyalty={() => setIntent({ action: 'royalty', collection: address, name: c.name, currentBps: m.royaltyBps })}
        />
      ) : null}

      {/* Buy floor and collection offer */}
      {m.tradable ? (
        <div className="fixed inset-x-0 bottom-[calc(var(--app-nav-h)+var(--app-nav-overhang))] z-40 border-t border-[#1c1e22] bg-ink/95 px-4 py-[10px] backdrop-blur-md md:bottom-0">
          <div className="mx-auto grid max-w-lg grid-cols-2 gap-[10px]">
            <button
              type="button"
              disabled={!floorListing || m.paused}
              onClick={() =>
                floorListing &&
                setIntent({ action: 'buy', collection: address, tokenId: floorListing.tokenId, name: floorListing.name, priceWei: floorListing.priceWei! })
              }
              className="btn-sun h-[46px] gap-[8px] rounded-[10px] font-sans text-[14px] disabled:opacity-50"
            >
              <CartIcon size={17} />
              {floorListing ? 'Buy Floor' : 'No listings'}
            </button>
            <button
              type="button"
              disabled={m.paused}
              onClick={() => setIntent({ action: 'offer', collection: address, tokenId: null, name: c.name })}
              className="flex h-[46px] items-center justify-center gap-[8px] rounded-[10px] border border-[#3a3b40] bg-[#0d0d0e] font-sans text-[14px] font-semibold text-white disabled:opacity-50"
            >
              <TagIcon size={16} />
              Make Offer
            </button>
          </div>
          {m.paused ? <p className="m-0 mt-[6px] text-center font-sans text-[11px] text-sun">Trading is paused right now.</p> : null}
        </div>
      ) : null}

      {intent ? (
        <NftTradeSheet
          intent={intent}
          royaltyBps={m.royaltyBps}
          usdPerEth={usd}
          network={data.network}
          onClose={() => setIntent(null)}
          onDone={refreshAfterTrade}
        />
      ) : null}
      {chartOpen ? <FloorChartSheet points={stats?.series ?? []} name={c.name} onClose={() => setChartOpen(false)} /> : null}
    </div>
  );
}

function BackButton() {
  return (
    <Link
      href="/dashboard/explore?s=nfts"
      aria-label="Back to NFTs"
      className="hit-44 flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-[#141416] text-white no-underline"
    >
      <ArrowLeftIcon size={19} />
    </Link>
  );
}

function BackBar() {
  return (
    <div className="flex items-center gap-[10px]">
      <BackButton />
      <span className="font-sans text-[17px] font-semibold text-white">Flizy NFTs</span>
    </div>
  );
}

function Figure({ label, divider = false, children }: { label: string; divider?: boolean; children: ReactNode }) {
  return (
    <div className={`min-w-0 px-[14px] ${divider ? 'border-l border-[#23242a]' : ''}`}>
      <p className="m-0 mb-[6px] font-sans text-[11px] uppercase tracking-wide text-[#a9a9a9]">{label}</p>
      {children}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <span className="block font-sans text-[13px] font-medium text-[#8d8d8d]">{children}</span>;
}

function ItemCard({
  card,
  collectionName,
  usdPerEth,
  favorite,
  onFavorite,
  action,
}: {
  card: NftCardData;
  collectionName: string;
  usdPerEth: number | null;
  favorite: boolean;
  onFavorite: () => void;
  action: { label: string; icon: ReactNode; run: () => void } | null;
}) {
  return (
    // min-w-0: a grid item otherwise grows to its image's natural width.
    <article className="relative min-w-0 overflow-hidden rounded-[12px] border border-[#23242a] bg-[#0d0d0e]">
      <Link href={itemHref(card.collection, card.tokenId)} className="block no-underline">
        <NftArt src={card.image} alt={card.name} initial={collectionName} className="aspect-square w-full" />
        <div className="px-[10px] pt-[9px]">
          <p className="m-0 truncate font-sans text-[13.5px] font-medium text-white">{card.name}</p>
          <div className="mt-[4px] min-h-[34px]">
            {card.priceWei ? (
              <PriceBlock wei={card.priceWei} usdPerEth={usdPerEth} />
            ) : (
              <span className="block pt-[2px] font-sans text-[12px] text-[#9a9a9a]">Not listed</span>
            )}
          </div>
        </div>
      </Link>
      {/* Positioned by a wrapper: .hit-44 sets position: relative on the button itself. */}
      <span className="absolute right-[8px] top-[8px]">
        <button
          type="button"
          onClick={onFavorite}
          aria-pressed={favorite}
          aria-label={favorite ? `Remove ${card.name} from favorites` : `Add ${card.name} to favorites`}
          className="hit-44 flex h-[30px] w-[30px] items-center justify-center rounded-full bg-[#0b0b0c]/75 text-white"
        >
          <HeartIcon size={16} filled={favorite} className={favorite ? 'text-sun' : ''} />
        </button>
      </span>
      <div className="px-[10px] pb-[10px] pt-[8px]">
        {action ? (
          <button type="button" onClick={action.run} className="btn-sun h-[36px] w-full gap-[7px] rounded-[8px] font-sans text-[13px]">
            {action.icon}
            {action.label}
          </button>
        ) : (
          <Link href={itemHref(card.collection, card.tokenId)} className="flex h-[36px] w-full items-center justify-center rounded-[8px] border border-[#2a2b30] font-sans text-[12.5px] text-white no-underline">
            View
          </Link>
        )}
      </div>
    </article>
  );
}

type ActivityRow = {
  kind: 'sale' | 'list' | 'cancel' | 'offer' | 'mint' | 'transfer' | 'burn';
  tokenId: string | null;
  from: string | null;
  to: string | null;
  priceWei: string | null;
  txHash: string;
  timestamp: string | null;
};

const KIND_LABEL: Record<ActivityRow['kind'], string> = {
  sale: 'Sale',
  list: 'Listed',
  cancel: 'Delisted',
  offer: 'Offer',
  mint: 'Minted',
  transfer: 'Transfer',
  burn: 'Burned',
};

function ActivityTab({ address, usdPerEth }: { address: string; usdPerEth: number | null }) {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [explorer, setExplorer] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(
    async (cursor: string | null) => {
      try {
        const r = await getJson<{ rows: ActivityRow[]; next: string | null; explorerBaseUrl: string }>(
          `/api/nfts/collections/${address}/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
        );
        setRows((prev) => (cursor && prev ? [...prev, ...r.rows] : r.rows));
        setNext(r.next);
        setExplorer(r.explorerBaseUrl);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load activity.');
      }
    },
    [address]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  if (error) return <p className="alert alert-error m-0 mt-[14px]">{error}</p>;
  if (!rows) return <p className="m-0 mt-[14px] font-sans text-[12px] text-[#a9a9a9]">Loading activity...</p>;
  if (!rows.length) return <p className="m-0 mt-[14px] font-sans text-[12.5px] text-[#a9a9a9]">Nothing has happened in this collection yet.</p>;

  return (
    <div className="mt-[10px]">
      <ul className="m-0 list-none p-0">
        {rows.map((r, i) => (
          <li key={`${r.txHash}-${r.kind}-${i}`} className="flex items-center gap-[12px] border-b border-[#1b1c20] py-[12px]">
            <span
              className={`flex h-[26px] min-w-[70px] items-center justify-center rounded-full px-[8px] font-sans text-[11px] ${
                r.kind === 'sale' ? 'bg-sun text-[#1a1405]' : 'border border-[#2c2d33] text-[#d6d6d6]'
              }`}
            >
              {KIND_LABEL[r.kind]}
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 truncate font-sans text-[13px] text-white">
                {r.tokenId ? (
                  <Link href={itemHref(address, r.tokenId)} className="text-white no-underline">
                    #{r.tokenId}
                  </Link>
                ) : (
                  'Collection offer'
                )}
                {r.priceWei ? <span className="text-[#cfcfcf]"> · {ethFromWei(r.priceWei)} ETH</span> : null}
              </p>
              <p className="m-0 mt-[2px] truncate font-sans text-[11.5px] text-[#9a9a9a]">
                {r.kind === 'mint' ? `to ${shortAddr(r.to)}` : r.to ? `${shortAddr(r.from)} to ${shortAddr(r.to)}` : `by ${shortAddr(r.from)}`}
                {r.priceWei && usdLabel(r.priceWei, usdPerEth) ? ` · ${usdLabel(r.priceWei, usdPerEth)}` : ''}
              </p>
            </div>
            <a href={`${explorer}/tx/${r.txHash}`} target="_blank" rel="noreferrer noopener" className="shrink-0 font-sans text-[11.5px] text-[#9a9a9a] no-underline hover:text-white">
              {timeAgo(r.timestamp) || 'tx'}
            </a>
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

function HoldersTab({ address, viewer }: { address: string; viewer: string | null }) {
  const [rows, setRows] = useState<Array<{ address: string; count: number }> | null>(null);
  const [meta, setMeta] = useState<{ total: number | null; supply: string | null; explorerBaseUrl: string } | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(
    async (cursor: string | null) => {
      try {
        const r = await getJson<{ holders: Array<{ address: string; count: number }>; next: string | null; total: number | null; supply: string | null; explorerBaseUrl: string }>(
          `/api/nfts/collections/${address}/holders${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
        );
        setRows((prev) => (cursor && prev ? [...prev, ...r.holders] : r.holders));
        setNext(r.next);
        setMeta({ total: r.total, supply: r.supply, explorerBaseUrl: r.explorerBaseUrl });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load holders.');
      }
    },
    [address]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  if (error) return <p className="alert alert-error m-0 mt-[14px]">{error}</p>;
  if (!rows) return <p className="m-0 mt-[14px] font-sans text-[12px] text-[#a9a9a9]">Loading holders...</p>;
  const supply = meta?.supply ? Number(meta.supply) : null;

  return (
    <div className="mt-[12px]">
      <p className="m-0 font-sans text-[12.5px] text-[#a9a9a9]">
        {compactCount(meta?.total ?? rows.length)} holders{supply ? ` of ${compactCount(supply)} items` : ''}
      </p>
      <ol className="m-0 mt-[6px] list-none p-0">
        {rows.map((h, i) => (
          <li key={h.address} className="flex items-center gap-[12px] border-b border-[#1b1c20] py-[11px]">
            <span className="w-[22px] shrink-0 font-sans text-[12px] text-[#8d8d8d]">{i + 1}</span>
            <a href={`${meta?.explorerBaseUrl}/address/${h.address}`} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate font-sans text-[13px] text-white no-underline">
              {shortAddr(h.address)}
              {viewer === h.address ? <span className="ml-[6px] text-sun">You</span> : null}
            </a>
            <span className="shrink-0 font-sans text-[13px] text-white">{h.count}</span>
            <span className="w-[54px] shrink-0 text-right font-sans text-[12px] text-[#9a9a9a]">
              {supply ? `${((h.count / supply) * 100).toFixed(1)}%` : ''}
            </span>
          </li>
        ))}
      </ol>
      {next ? (
        <button type="button" onClick={() => load(next)} className="mt-[12px] h-[40px] w-full rounded-[9px] border border-[#2a2b30] font-sans text-[12.5px] text-white">
          Load more
        </button>
      ) : null}
    </div>
  );
}

function TraitsTab({ address, onPick }: { address: string; onPick: (value: string) => void }) {
  const [data, setData] = useState<{ traits: Array<{ trait: string; values: Array<{ value: string; count: number }> }>; read: number; complete: boolean } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getJson<typeof data>(`/api/nfts/collections/${address}/traits`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load traits.'));
  }, [address]);

  if (error) return <p className="alert alert-error m-0 mt-[14px]">{error}</p>;
  if (!data) return <p className="m-0 mt-[14px] font-sans text-[12px] text-[#a9a9a9]">Loading traits...</p>;
  if (!data.traits.length) {
    return (
      <p className="m-0 mt-[14px] rounded-[10px] border border-[#23242a] bg-[#0d0d0e] p-[16px] font-sans text-[12.5px] leading-[18px] text-[#a9a9a9]">
        This collection&apos;s tokens carry no traits in their metadata.
      </p>
    );
  }
  return (
    <div className="mt-[12px] grid grid-cols-[minmax(0,1fr)] gap-[14px]">
      {!data.complete ? (
        <p className="m-0 font-sans text-[11.5px] text-[#8d8d8d]">Counted over the first {data.read} items.</p>
      ) : null}
      {data.traits.map((t) => (
        <section key={t.trait}>
          <h4 className="m-0 font-sans text-[12px] uppercase tracking-wide text-[#a9a9a9]">{t.trait}</h4>
          <div className="mt-[8px] flex flex-wrap gap-[7px]">
            {t.values.map((v) => (
              <button
                key={v.value}
                type="button"
                onClick={() => onPick(v.value)}
                className="flex h-[32px] items-center gap-[8px] rounded-full border border-[#2c2d33] px-[12px] font-sans text-[12.5px] text-white"
              >
                {v.value}
                <span className="text-[#8d8d8d]">{v.count}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function AboutTab({ data, isCreator, onRoyalty }: { data: CollectionData; isCreator: boolean; onRoyalty: () => void }) {
  const c = data.collection;
  const m = data.market;
  const rows: Array<[string, ReactNode]> = [
    [
      'Contract',
      <a key="c" href={`${data.explorerBaseUrl}/token/${c.address}`} target="_blank" rel="noreferrer noopener" className="text-white no-underline">
        {shortAddr(c.address)}
      </a>,
    ],
    ['Standard', c.standard],
    ['Network', data.network],
    ['Symbol', c.symbol ?? '-'],
    ['Items', c.maxSupply ? `${compactCount(c.supply)} of ${compactCount(c.maxSupply)}` : compactCount(c.supply)],
    ['Owners', compactCount(c.holders)],
    ['Created', monthYear(c.createdAt) ?? '-'],
    [
      'Creator',
      c.creator ? (
        <a key="cr" href={`${data.explorerBaseUrl}/address/${c.creator}`} target="_blank" rel="noreferrer noopener" className="text-white no-underline">
          {c.profile?.creator ? `${c.profile.creator} (${shortAddr(c.creator)})` : shortAddr(c.creator)}
        </a>
      ) : (
        '-'
      ),
    ],
    ['Flizy fee', `${bpsLabel(m.feeBps)} of each sale`],
    ['Creator royalty', m.enabled ? (m.royaltyBps ? `${bpsLabel(m.royaltyBps)} to ${shortAddr(m.royaltyReceiver)}` : 'None') : '-'],
    ['Verified by Flizy', c.verified ? 'Yes' : 'No'],
    ['Send in chat', c.verified ? `Yes, as ${c.ticker}` : 'No. Only verified collections can be sent on socials.'],
  ];
  if (c.freeMint) rows.splice(5, 0, ['Mint', 'Free, one per wallet']);

  return (
    <div className="mt-[12px] grid grid-cols-[minmax(0,1fr)] gap-[14px]">
      <dl className="m-0 rounded-[12px] border border-[#23242a] bg-[#0d0d0e] px-[14px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-[16px] border-b border-[#1b1c20] py-[11px] last:border-0">
            <dt className="shrink-0 font-sans text-[12.5px] text-[#a9a9a9]">{label}</dt>
            <dd className="m-0 text-right font-sans text-[12.5px] text-white">{value}</dd>
          </div>
        ))}
      </dl>
      {isCreator && m.enabled ? (
        <button type="button" onClick={onRoyalty} className="h-[42px] rounded-[9px] border border-sun font-sans text-[13px] text-sun">
          Set creator royalty
        </button>
      ) : null}
      {c.freeMint && c.ticker ? (
        <p className="m-0 font-sans text-[12px] leading-[18px] text-[#a9a9a9]">
          Mint one free in chat: <span className="font-mono text-white">flizy mint 1 {c.ticker}</span> on WhatsApp, or{' '}
          <span className="font-mono text-white">/mint 1 {c.ticker}</span> on Telegram.
        </p>
      ) : null}
    </div>
  );
}
