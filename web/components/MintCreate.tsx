'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MintActionSheet, SheetRow } from './MintActionSheet';
import { NftArt } from './NftCollection';
import { CollectionCreator, type CreatorStart } from './CollectionCreator';
import { AiCollectionCreator } from './AiCollectionCreator';
import { CheckIcon, ChevronRightIcon, PlusIcon } from './ExploreIcons';
import { ethFromWei, shortAddr } from '../lib/nftFormat';
import { safeImageUrl } from '../lib/nftIndex';

type Mode = 'choose' | 'flizy' | 'ai' | 'new' | 'existing';

type Detection = {
  collection: string;
  name: string | null;
  owner: string | null;
  isOwner: boolean;
  totalSupply: number | null;
  maxSupply: number | null;
  priceWei: string | null;
  mintFns: string[];
  mode: 'flizy' | 'external' | 'none';
  verified: boolean;
  alreadyOnFlizy: boolean;
  flizyDrop: string | null;
};

const FN_LABELS: Record<string, string> = {
  claim: 'claim()',
  mint: 'mint()',
  mint_qty: 'mint(quantity)',
  public_mint_qty: 'publicMint(quantity)',
};

const MAX_SUPPLY = 10_000;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid gap-[6px]">
      <span className="font-sans text-[11px] uppercase tracking-wide text-[#a9a9a9]">{label}</span>
      {children}
      {hint ? <span className="font-sans text-[11px] leading-[15px] text-[#8d8d8d]">{hint}</span> : null}
    </label>
  );
}

const INPUT =
  'h-[44px] w-full rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] px-[12px] font-sans text-[15px] text-white outline-none focus:border-sun';

/** Printable ASCII without quotes or backslashes: what goes on chain in the collection metadata. */
function plain(text: string, max: number): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= max && /^[\x20-\x7e]+$/.test(t) && !/["\\]/.test(t);
}

function artOk(url: string): boolean {
  return /^(https|ipfs):\/\/[\x21-\x7e]{1,500}$/.test(url.trim()) && !/["\\]/.test(url);
}

/**
 * Create a Mint. Create with Flizy builds a collection from the creator's
 * artwork layers (see CollectionCreator). Import brings a contract that
 * already exists: it is checked first (Verify collection) and becomes
 * Flizy-managed or Contract-managed depending on what the contract supports.
 * The manual path deploys a single-image collection from the creator's wallet
 * and sets it up on the manage page. Generate with AI is shown, not open.
 */
export function MintCreate() {
  const [mode, setMode] = useState<Mode>('choose');
  const [start, setStart] = useState<CreatorStart | null>(null);

  return (
    <div className="grid w-full gap-[16px] pt-[6px]">
      <div className="flex items-center justify-between">
        <Link href="/dashboard/explore?s=nfts&nft=mint" className="hit-y-44 font-sans text-[12.5px] text-[#cfcfcf] no-underline hover:text-white">
          Back to Mint
        </Link>
        <Link href="/dashboard/explore/nfts/mints" className="hit-y-44 font-sans text-[12.5px] text-sun no-underline">
          My Mints
        </Link>
      </div>
      <div>
        <h1 className="m-0 font-sans text-[20px] font-bold text-white">Create a Mint</h1>
        <p className="m-0 mt-[4px] font-sans text-[12.5px] leading-[18px] text-[#a9a9a9]">
          Launch a collection on Flizy and let your community mint it here.
        </p>
      </div>

      {mode === 'choose' ? (
        <div className="grid gap-[10px]">
          <div>
            <h2 className="m-0 font-sans text-[16px] font-semibold text-white">Create your NFT collection</h2>
            <p className="m-0 mt-[3px] font-sans text-[12.5px] text-[#a9a9a9]">Choose how you want to create your collection.</p>
          </div>
          <div className="grid gap-[10px] lg:grid-cols-3">
            <Path
              icon={<LayersIcon size={20} />}
              title="Create with Flizy"
              lead="Build a collection from your own artwork layers."
              text="Upload layers such as backgrounds, bodies, clothes, eyes and accessories. Flizy combines them into unique NFTs and writes the metadata."
              action="Create with Flizy"
              onClick={() => {
                setStart(null);
                setMode('flizy');
              }}
            />
            <Path
              icon={<SparkIcon size={20} />}
              title="Generate with AI"
              lead="Describe your idea and let Flizy build the collection."
              text="Describe the characters, art style, traits, rarity and size, and Flizy generates the artwork, traits and metadata."
              action="Generate with AI"
              onClick={() => setMode('ai')}
            />
            <Path
              icon={<UploadBoxIcon size={20} />}
              title="Import existing collection"
              lead="Already have your NFT collection? Bring it to Flizy."
              text="Your contract already exists. Flizy checks what it supports and gives your community a mint page."
              action="Import collection"
              onClick={() => setMode('existing')}
            />
          </div>
          <div className="mt-[6px] flex items-center gap-[10px] font-sans text-[11px] uppercase tracking-wide text-[#8d8d8d]">
            <span className="h-px flex-1 bg-[#23242a]" />
            Advanced / Manual
            <span className="h-px flex-1 bg-[#23242a]" />
          </div>
          <Choice
            title="Create a collection manually"
            text="One image for every NFT. Flizy deploys the collection to your wallet and runs the mint: phases, allowlist, limits and price."
            onClick={() => setMode('new')}
          />
        </div>
      ) : null}
      {mode === 'flizy' ? <CollectionCreator start={start} onBack={() => setMode('choose')} /> : null}
      {mode === 'ai' ? (
        <AiCollectionCreator
          onBack={() => setMode('choose')}
          onReady={(next) => {
            setStart(next);
            setMode('flizy');
            window.scrollTo({ top: 0 });
          }}
        />
      ) : null}
      {mode === 'new' ? <NewCollection onBack={() => setMode('choose')} /> : null}
      {mode === 'existing' ? <ExistingCollection onBack={() => setMode('choose')} /> : null}
    </div>
  );
}

/** One way to create. */
function Path({
  icon,
  title,
  lead,
  text,
  action,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  lead: string;
  text: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <section className="flex flex-col gap-[8px] rounded-[12px] border border-[#2a2b30] bg-[#0d0d0e] p-[14px]">
      <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] border border-[#3a3017] bg-[#1c180c] text-sun">
        {icon}
      </span>
      <h3 className="m-0 font-sans text-[15px] font-semibold text-white">{title}</h3>
      <p className="m-0 font-sans text-[13px] font-medium text-[#e6e6e6]">{lead}</p>
      <p className="m-0 flex-1 font-sans text-[12px] leading-[17px] text-[#a9a9a9]">{text}</p>
      <button type="button" onClick={onClick} className="btn-sun mt-[4px] h-[40px] gap-[6px] rounded-[8px] font-sans text-[13px]">
        {action} <ChevronRightIcon size={13} />
      </button>
    </section>
  );
}

function Choice({ title, text, onClick }: { title: string; text: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-center justify-between gap-[12px] rounded-[10px] border border-[#2a2b30] bg-[#0d0d0e] p-[14px] text-left hover:border-sun">
      <span className="grid gap-[4px]">
        <span className="font-sans text-[14px] font-semibold text-white">{title}</span>
        <span className="font-sans text-[12px] leading-[17px] text-[#a9a9a9]">{text}</span>
      </span>
      <ChevronRightIcon size={14} className="shrink-0 text-[#cfcfcf]" />
    </button>
  );
}

function NewCollection({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [supply, setSupply] = useState('1000');
  const [imageUrl, setImageUrl] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [description, setDescription] = useState('');
  const [royalty, setRoyalty] = useState('5');
  const [sheet, setSheet] = useState(false);

  const supplyN = Number(supply);
  const royaltyN = Number(royalty);
  const problems: string[] = [];
  if (!plain(name, 64)) problems.push('Name: 1 to 64 plain characters, no quotes or backslashes.');
  if (!plain(symbol, 16)) problems.push('Symbol: 1 to 16 plain characters.');
  if (!Number.isInteger(supplyN) || supplyN < 1 || supplyN > MAX_SUPPLY) problems.push(`Supply: a whole number from 1 to ${MAX_SUPPLY.toLocaleString('en-US')}.`);
  if (!artOk(imageUrl)) problems.push('Artwork: an https:// or ipfs:// link to the image.');
  if (bannerUrl && !artOk(bannerUrl)) problems.push('Banner: an https:// or ipfs:// link, or leave it empty.');
  if (!/^[0-9]{1,2}(\.[0-9]{1,2})?$/.test(royalty.trim()) || royaltyN > 10) problems.push('Royalty: 0 to 10%.');
  if (description.length > 2000) problems.push('Description: under 2000 characters.');
  const ready = problems.length === 0;

  return (
    <div className="grid gap-[14px]">
      <button type="button" onClick={onBack} className="hit-y-44 justify-self-start font-sans text-[12px] text-[#cfcfcf]">
        Change how you launch
      </button>
      <h2 className="m-0 font-sans text-[15px] font-semibold text-white">New Flizy collection</h2>
      <Field label="Collection name">
        <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} placeholder="Franky the Frog" />
      </Field>
      <Field label="Symbol">
        <input className={INPUT} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} maxLength={16} placeholder="FRANK" />
      </Field>
      <Field label="Supply" hint={`How many NFTs can ever exist, up to ${MAX_SUPPLY.toLocaleString('en-US')}. It can never be raised later.`}>
        <input className={INPUT} inputMode="numeric" value={supply} onChange={(e) => setSupply(e.target.value.replace(/[^0-9]/g, ''))} />
      </Field>
      <Field label="Artwork" hint="Every NFT in the collection uses this image, named with its number (#1, #2, ...). Use a permanent https:// or ipfs:// link.">
        <input className={INPUT} value={imageUrl} onChange={(e) => setImageUrl(e.target.value.trim())} placeholder="ipfs://..." autoComplete="off" />
      </Field>
      {artOk(imageUrl) ? (
        <NftArt src={safeImageUrl(imageUrl)} alt="Artwork preview" initial={name || 'N'} className="h-[120px] w-[120px] rounded-[10px]" />
      ) : null}
      <Field label="Banner (optional)">
        <input className={INPUT} value={bannerUrl} onChange={(e) => setBannerUrl(e.target.value.trim())} placeholder="https://..." autoComplete="off" />
      </Field>
      <Field label="Description (optional)">
        <textarea
          className="min-h-[90px] w-full rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] p-[12px] font-sans text-[14px] text-white outline-none focus:border-sun"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
        />
      </Field>
      <Field label="Creator royalty on resales (%)" hint="Paid to your wallet from every resale on Flizy, after the 2% Flizy fee. Traders see it before they buy. 0 to 10%.">
        <input className={INPUT} inputMode="decimal" value={royalty} onChange={(e) => setRoyalty(e.target.value)} />
      </Field>

      {!ready && (name || imageUrl) ? (
        <ul className="m-0 grid gap-[3px] pl-[16px] font-sans text-[11.5px] text-[#d9a24a]">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      <button type="button" disabled={!ready} onClick={() => setSheet(true)} className="btn-sun h-[46px] rounded-[6px] font-sans text-[14px] font-semibold disabled:opacity-50">
        Create collection
      </button>
      <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
        Creating a collection is free on Flizy; your wallet pays only network gas. You set the mint price and schedule next.
      </p>

      {sheet ? (
        <MintActionSheet
          title="Create collection"
          subtitle={name}
          confirmLabel="Create collection"
          url="/api/mints/collections"
          body={{
            name: name.trim(),
            symbol: symbol.trim(),
            supply: supplyN,
            imageUrl: imageUrl.trim(),
            bannerUrl: bannerUrl.trim(),
            description: description.trim(),
            royaltyBps: Math.round(royaltyN * 100),
          }}
          onClose={() => setSheet(false)}
          onDone={(result) => {
            const collection = typeof result.collection === 'string' ? result.collection : null;
            if (collection) router.push(`/dashboard/explore/nfts/mints/${collection}`);
          }}
        >
          <div className="grid gap-[7px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[12px]">
            <SheetRow label="Name" value={name.trim()} />
            <SheetRow label="Symbol" value={symbol.trim()} />
            <SheetRow label="Supply" value={supplyN.toLocaleString('en-US')} />
            <SheetRow label="Creator royalty" value={`${royaltyN}%`} />
            <SheetRow label="Owner" value="Your Flizy wallet" />
            <div className="my-[2px] h-px bg-[#23242a]" />
            <SheetRow label="Cost" value="Network gas only" strong />
          </div>
        </MintActionSheet>
      ) : null}
    </div>
  );
}

function ExistingCollection({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [address, setAddress] = useState('');
  const [d, setD] = useState<Detection | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [saving, setSaving] = useState(false);

  async function verify() {
    setChecking(true);
    setError('');
    setD(null);
    try {
      const res = await fetch(`/api/mints/detect?collection=${encodeURIComponent(address.trim())}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setError(body.error || 'Could not check this contract.');
      else setD(body as Detection);
    } catch {
      setError('Could not check this contract.');
    } finally {
      setChecking(false);
    }
  }

  async function bring() {
    if (!d) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/mints/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: d.collection, description, imageUrl, bannerUrl }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Could not bring this collection.');
        return;
      }
      router.push(body.mode === 'flizy' ? `/dashboard/explore/nfts/mints/${body.collection}` : `/dashboard/explore/nfts/mint/${body.collection}`);
    } catch {
      setError('Could not bring this collection.');
    } finally {
      setSaving(false);
    }
  }

  const canBring = d != null && d.isOwner && d.mode !== 'none' && !d.alreadyOnFlizy && (!imageUrl || artOk(imageUrl)) && (!bannerUrl || artOk(bannerUrl));

  return (
    <div className="grid gap-[14px]">
      <button type="button" onClick={onBack} className="hit-y-44 justify-self-start font-sans text-[12px] text-[#cfcfcf]">
        Change how you launch
      </button>
      <h2 className="m-0 font-sans text-[15px] font-semibold text-white">Bring your collection to Flizy</h2>
      <Field label="Collection contract" hint="The ERC-721 contract on GIWA Sepolia. Only the contract's owner can bring it.">
        <div className="flex gap-[8px]">
          <input className={`${INPUT} font-mono text-[13px]`} value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x..." autoComplete="off" spellCheck={false} />
          <button type="button" onClick={verify} disabled={checking || !/^0x[0-9a-fA-F]{40}$/.test(address)} className="btn-sun h-[44px] shrink-0 rounded-[6px] px-[14px] font-sans text-[12.5px] disabled:opacity-50">
            {checking ? 'Checking...' : 'Verify collection'}
          </button>
        </div>
      </Field>
      {error ? <p className="alert alert-error m-0">{error}</p> : null}

      {d ? (
        <section className="grid gap-[8px] rounded-[10px] border border-[#2a2b30] bg-[#0d0d0e] p-[14px]" aria-label="What Flizy found">
          <h3 className="m-0 font-sans text-[14px] font-semibold text-white">{d.name || shortAddr(d.collection)}</h3>
          <SheetRow label="Minted" value={`${d.totalSupply ?? '-'}${d.maxSupply != null ? ` / ${d.maxSupply.toLocaleString('en-US')}` : ''}`} />
          <SheetRow label="Owner" value={d.owner ? (d.isOwner ? 'Your wallet' : shortAddr(d.owner)) : 'No owner()'} />
          <SheetRow label="Price" value={d.priceWei == null ? 'Not published by the contract' : d.priceWei === '0' ? 'Free' : `${ethFromWei(d.priceWei)} ETH`} />
          <SheetRow label="Mint functions" value={d.mintFns.length ? d.mintFns.map((f) => FN_LABELS[f] ?? f).join(', ') : 'None Flizy supports'} />
          <div className="my-[2px] h-px bg-[#23242a]" />
          {d.mode === 'flizy' ? (
            <p className="m-0 inline-flex items-center gap-[6px] font-sans text-[12.5px] text-sun">
              <CheckIcon size={13} strokeWidth={2.6} /> Flizy-managed: you set phases, allowlist, limits and price here.
            </p>
          ) : d.mode === 'external' ? (
            <p className="m-0 font-sans text-[12px] leading-[17px] text-[#d6d6d6]">
              <span className="font-semibold text-white">Contract-managed.</span> Flizy will call the contract&apos;s own mint function. Its
              price, limits and schedule stay whatever the contract enforces; Flizy cannot add phases or an allowlist to it.
              {d.flizyDrop ? (
                <>
                  {' '}
                  For a Flizy-managed mint, a contract implements IFlizyMintable and names FlizyDrop{' '}
                  <span className="font-mono">{shortAddr(d.flizyDrop)}</span> as its minter.
                </>
              ) : null}
            </p>
          ) : (
            <p className="m-0 font-sans text-[12px] leading-[17px] text-[#d9a24a]">
              Flizy found no mint function it supports (claim, mint, publicMint), and the contract does not name FlizyDrop as its
              minter. It can still be traded on Flizy, but not minted here.
            </p>
          )}
          {d.alreadyOnFlizy ? <p className="m-0 font-sans text-[12px] text-[#d9a24a]">This collection is already on Flizy.</p> : null}
          {d.owner && !d.isOwner ? (
            <p className="m-0 font-sans text-[12px] text-[#d9a24a]">Only the contract owner can bring it. Its owner is a different wallet.</p>
          ) : null}
        </section>
      ) : null}

      {d && d.isOwner && d.mode !== 'none' && !d.alreadyOnFlizy ? (
        <>
          <Field label="Artwork (optional)" hint="Shown on Flizy. An https:// or ipfs:// link.">
            <input className={INPUT} value={imageUrl} onChange={(e) => setImageUrl(e.target.value.trim())} placeholder="ipfs://..." autoComplete="off" />
          </Field>
          <Field label="Banner (optional)">
            <input className={INPUT} value={bannerUrl} onChange={(e) => setBannerUrl(e.target.value.trim())} placeholder="https://..." autoComplete="off" />
          </Field>
          <Field label="Description (optional)">
            <textarea
              className="min-h-[80px] w-full rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] p-[12px] font-sans text-[14px] text-white outline-none focus:border-sun"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </Field>
          <button type="button" onClick={bring} disabled={!canBring || saving} className="btn-sun inline-flex h-[46px] items-center justify-center gap-[6px] rounded-[6px] font-sans text-[14px] font-semibold disabled:opacity-50">
            <PlusIcon size={13} /> {saving ? 'Bringing...' : 'Bring to Flizy'}
          </button>
          <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
            No transaction: this lists your collection on Flizy Mint. It shows as Not verified until Flizy verifies it.
          </p>
        </>
      ) : null}
    </div>
  );
}

function LayersIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 21 8l-9 5-9-5 9-5z" />
      <path d="m3 12.5 9 5 9-5M3 17l9 5 9-5" strokeLinecap="round" />
    </svg>
  );
}

function SparkIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5 13.9 9.6 20 11.5l-6.1 1.9L12 19.5l-1.9-6.1L4 11.5l6.1-1.9L12 3.5z" />
      <path d="M19 3v3M17.5 4.5h3" strokeLinecap="round" />
    </svg>
  );
}

function UploadBoxIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14" />
    </svg>
  );
}
