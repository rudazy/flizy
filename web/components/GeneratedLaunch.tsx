'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatEther } from 'ethers';
import { MintActionSheet, SheetRow } from './MintActionSheet';
import type { GeneratedToken } from '../lib/collectionGen';

export type GenerationStatus = {
  network: string;
  feeUsd: number;
  feeWei: string | null;
  usdPerEth: number | null;
  window: { paidAt: string; until: string; supply: number } | null;
  storage: boolean;
  metadataFactory: boolean;
  aiPlan: boolean;
  aiImages: boolean;
};

/** What the server says is set up and paid. Null while loading; refresh after a payment. */
export function useGenerationStatus(): { status: GenerationStatus | null; failed: boolean; refresh: () => void } {
  const [status, setStatus] = useState<GenerationStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(() => {
    fetch('/api/mints/generated/status')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        setStatus((await res.json()) as GenerationStatus);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(refresh, [refresh]);
  return { status, failed, refresh };
}

/** Why launching cannot happen yet, in plain words, or null when everything is set up. */
export function launchBlocker(status: GenerationStatus | null): string | null {
  if (!status) return null;
  if (!status.metadataFactory) return 'Launching generated collections is not live yet: the collection contract for NFTs with their own art is not deployed.';
  if (!status.storage) return 'Launching generated collections is not live yet: image storage is not set up.';
  return null;
}

/** The fee in full, not rounded: it is the exact amount the wallet sends. */
function FeeEth({ wei }: { wei: string }) {
  return <>{formatEther(BigInt(wei))} ETH</>;
}

/** The $2 fee, its test ETH amount, and that gas is separate. Pays through the usual password sheet. */
export function FeePanel({
  status,
  name,
  supply,
  onPaid,
  onClosed,
}: {
  status: GenerationStatus;
  name: string;
  supply: number;
  onPaid: () => void;
  onClosed: () => void;
}) {
  const [sheet, setSheet] = useState(false);
  const paid = status.window && status.window.supply >= supply;
  return (
    <div className="grid gap-[8px] rounded-[10px] border border-[#23242a] bg-[#0b0b0c] p-[12px] font-sans text-[12.5px]">
      <SheetRow label="Generation fee" value={`$${status.feeUsd.toFixed(2)}`} strong />
      <SheetRow
        label={`Paid in test ETH on ${status.network}`}
        value={status.feeWei ? <FeeEth wei={status.feeWei} /> : 'Price unavailable'}
      />
      <SheetRow label="Network gas" value="Paid separately by your wallet" />
      <p className="m-0 text-[11.5px] leading-[16px] text-[#8d8d8d]">
        The fee is $2 at the current ETH price and covers storing this collection{status.aiImages ? ' and drawing AI art' : ''} for 24 hours after you pay.
      </p>
      {paid ? (
        <p className="m-0 text-[#2fd27a]">Fee paid. Open until {new Date(status.window!.until).toLocaleString()}.</p>
      ) : (
        <button
          type="button"
          disabled={!status.feeWei}
          onClick={() => setSheet(true)}
          className="btn-sun h-[42px] rounded-[8px] font-sans text-[13.5px] disabled:opacity-50"
        >
          Pay generation fee
        </button>
      )}
      {sheet && status.feeWei ? (
        <MintActionSheet
          title="Pay generation fee"
          subtitle={name}
          confirmLabel="Pay fee"
          url="/api/mints/generated/pay"
          body={{ name, supply, quotedWei: status.feeWei }}
          onClose={() => {
            setSheet(false);
            onClosed();
          }}
          onDone={() => onPaid()}
        >
          <div className="grid gap-[7px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[12px]">
            <SheetRow label="Generation fee" value={`$${status.feeUsd.toFixed(2)}`} />
            <SheetRow label="You pay" value={<FeeEth wei={status.feeWei} />} strong />
            <SheetRow label="Goes to" value="Flizy fee wallet" />
            <SheetRow label="Network gas" value="Separate, paid by your wallet" />
          </div>
        </MintActionSheet>
      ) : null}
    </div>
  );
}

const CANVAS = 1024;
const MAX_UPLOAD_BYTES = 950_000;
const BATCH_BYTES = 2_600_000;
const BATCH_COUNT = 8;

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string, cache: boolean): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image'));
      img.src = src;
    });
    if (cache) imageCache.set(src, p);
  }
  return p;
}

const dataUrlBytes = (url: string) => Math.floor(((url.length - url.indexOf(',') - 1) * 3) / 4);

/**
 * Stack layer images into one square picture, each fitted inside the canvas,
 * and encode it small enough to store: WebP first, smaller sizes if needed.
 * Layers are cached for the next NFT unless `cache` is false (a one-off image).
 */
export async function composeImage(layers: string[], size = CANVAS, cache = true): Promise<string> {
  const images = await Promise.all(layers.map((src) => loadImage(src, cache)));
  for (const [side, quality] of [[size, 0.9], [size, 0.75], [Math.round(size * 0.75), 0.75], [Math.round(size / 2), 0.7]] as const) {
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('canvas');
    for (const img of images) {
      const scale = Math.min(side / img.naturalWidth, side / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      g.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
    }
    const url = canvas.toDataURL('image/webp', quality);
    if (dataUrlBytes(url) <= MAX_UPLOAD_BYTES) return url;
  }
  throw new Error('too large');
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'That did not go through.');
  return data;
}

/** Stored progress for one generated run, kept by the parent so leaving the step does not lose it. */
export type StoredRun = { key: string; uris: string[]; baseURI: string | null };

type Phase = 'idle' | 'images' | 'metadata' | 'ready';

/**
 * Launch a generated collection: pay the fee, store every NFT image and its
 * metadata on IPFS, then create the collection from the creator's wallet and
 * go on to set up the mint. Storing resumes where it stopped if it fails.
 */
export function GeneratedLaunch({
  runKey,
  stored,
  onStored,
  name,
  symbol,
  description,
  supply,
  royaltyBps,
  tokens,
  layersOf,
  attributesOf,
  canLaunch,
}: {
  runKey: string;
  stored: StoredRun | null;
  onStored: (run: StoredRun) => void;
  name: string;
  symbol: string;
  description: string;
  supply: number;
  royaltyBps: number;
  tokens: GeneratedToken[];
  /** The layer images of one NFT, bottom first. */
  layersOf: (t: GeneratedToken) => string[];
  attributesOf: (t: GeneratedToken) => Array<{ trait_type: string; value: string }>;
  canLaunch: boolean;
}) {
  const router = useRouter();
  const { status, failed, refresh } = useGenerationStatus();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState(false);
  const run = stored?.key === runKey ? stored : null;
  const uris = run?.uris ?? [];
  const runRef = useRef(run);
  runRef.current = run;

  const blocker = launchBlocker(status);
  const paid = Boolean(status?.window && status.window.supply >= supply);

  async function store() {
    if (phase === 'images' || phase === 'metadata') return;
    setError('');
    let current: StoredRun = runRef.current ?? { key: runKey, uris: [], baseURI: null };
    try {
      if (current.uris.length < tokens.length) {
        setPhase('images');
        let batch: string[] = [];
        let bytes = 0;
        const flush = async () => {
          if (!batch.length) return;
          const data = await postJson('/api/mints/generated/images', { images: batch });
          const got = Array.isArray(data.uris) ? data.uris.filter((u): u is string => typeof u === 'string') : [];
          if (got.length !== batch.length) throw new Error('Storage did not return every image.');
          current = { ...current, uris: [...current.uris, ...got] };
          onStored(current);
          batch = [];
          bytes = 0;
        };
        for (let i = current.uris.length; i < tokens.length; i++) {
          let url: string;
          try {
            url = await composeImage(layersOf(tokens[i]));
          } catch {
            throw new Error(`NFT ${i + 1} could not be drawn. Use smaller layer images.`);
          }
          const size = dataUrlBytes(url);
          if (batch.length >= BATCH_COUNT || bytes + size > BATCH_BYTES) await flush();
          batch.push(url);
          bytes += size;
        }
        await flush();
      }
      if (!current.baseURI) {
        setPhase('metadata');
        const data = await postJson('/api/mints/generated/metadata', {
          name,
          description,
          tokens: tokens.map((t, i) => ({ image: current.uris[i], attributes: attributesOf(t) })),
        });
        if (typeof data.baseURI !== 'string') throw new Error('Storage did not return the metadata folder.');
        current = { ...current, baseURI: data.baseURI };
        onStored(current);
      }
      setPhase('ready');
    } catch (e) {
      setPhase('idle');
      setError(e instanceof Error ? e.message : 'That did not go through.');
      refresh();
    }
  }

  if (failed) return <p className="m-0 font-sans text-[12.5px] text-[#e0b070]">Could not load the launch details. Refresh the page to try again.</p>;
  if (!status) return <p className="m-0 font-sans text-[12.5px] text-[#a9a9a9]">Loading launch details...</p>;

  const storedAll = Boolean(run?.baseURI) && uris.length === tokens.length;
  const busy = phase === 'images' || phase === 'metadata';

  return (
    <div className="grid gap-[12px]">
      {blocker ? (
        <div className="rounded-[10px] border border-[#5a3f1a] bg-[#1a130a] p-[12px] font-sans text-[12.5px] leading-[18px] text-[#e0b070]">
          {blocker} Your layers are not saved: leaving this page clears them.
        </div>
      ) : (
        <>
          <FeePanel status={status} name={name} supply={supply} onPaid={refresh} onClosed={refresh} />
          <ol className="m-0 grid list-none gap-[6px] p-0 font-sans text-[12.5px]" aria-label="Launch progress">
            <Progress done={paid} label="Generation fee paid" />
            <Progress
              done={uris.length === tokens.length}
              active={phase === 'images'}
              label={`Images stored: ${uris.length.toLocaleString('en-US')} of ${tokens.length.toLocaleString('en-US')}`}
            />
            <Progress done={Boolean(run?.baseURI)} active={phase === 'metadata'} label="Metadata stored" />
          </ol>
          {error ? (
            <p className="m-0 rounded-[8px] border border-[#5a3f1a] bg-[#1a130a] px-[12px] py-[8px] font-sans text-[12.5px] text-[#e0b070]" role="alert">
              {error}
            </p>
          ) : null}
          {storedAll ? (
            <button type="button" onClick={() => setSheet(true)} className="btn-sun h-[46px] rounded-[8px] font-sans text-[14px]">
              Launch collection
            </button>
          ) : (
            <button
              type="button"
              disabled={!paid || !canLaunch || busy}
              onClick={() => void store()}
              className="btn-sun h-[46px] rounded-[8px] font-sans text-[14px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Storing your collection...' : uris.length ? 'Continue storing' : 'Store collection'}
            </button>
          )}
          <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
            {canLaunch
              ? 'Keep this page open while your collection is stored. Then launch it from your wallet and set the mint price and schedule.'
              : 'Fix the checks above before storing.'}
          </p>
        </>
      )}

      {sheet && run?.baseURI ? (
        <MintActionSheet
          title="Launch collection"
          subtitle={name}
          confirmLabel="Launch collection"
          url="/api/mints/collections"
          body={{
            name,
            symbol,
            supply,
            imageUrl: run.uris[0],
            description,
            royaltyBps,
            baseURI: run.baseURI,
          }}
          onClose={() => setSheet(false)}
          onDone={(result) => {
            const collection = typeof result.collection === 'string' ? result.collection : null;
            if (collection) router.push(`/dashboard/explore/nfts/mints/${collection}`);
          }}
        >
          <div className="grid gap-[7px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[12px]">
            <SheetRow label="Name" value={name} />
            <SheetRow label="Symbol" value={symbol} />
            <SheetRow label="Supply" value={supply.toLocaleString('en-US')} />
            <SheetRow label="Creator royalty" value={`${royaltyBps / 100}%`} />
            <SheetRow label="Owner" value="Your Flizy wallet" />
            <div className="my-[2px] h-px bg-[#23242a]" />
            <SheetRow label="Cost" value="Network gas only" strong />
          </div>
        </MintActionSheet>
      ) : null}
    </div>
  );
}

function Progress({ done, active = false, label }: { done: boolean; active?: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-[8px] ${done ? 'text-[#2fd27a]' : active ? 'text-sun' : 'text-[#a9a9a9]'}`}>
      <span className={`h-[8px] w-[8px] shrink-0 rounded-full ${done ? 'bg-[#2fd27a]' : active ? 'bg-sun' : 'bg-[#3a3b40]'}`} aria-hidden />
      {label}
    </li>
  );
}
