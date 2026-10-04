'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { parseEther } from 'ethers';
import { MintActionSheet, SheetRow, EthAmount } from './MintActionSheet';
import { MintStatusPill, type MintDrop } from './MintPanel';
import { TrashIcon } from './ExploreIcons';
import { ethFromWei, shortAddr } from '../lib/nftFormat';
import { feeBreakdown } from '../lib/mintDrop';
import { secToUtcInput, utcInputToSec } from '../lib/mintFormat';

type Stats = { revenueWei: string; feesWei: string; mintedViaFlizy: number; mintsToday: number };
/** As the API lists it: an entry added by username is known by the username only. */
type Entry = { key: string; label: string; allowance: number; source: 'username' | 'address' | 'csv' };
type Allowlist = {
  entries: Entry[];
  wallets: number;
  tokens: number;
  bySource: { username: number; address: number; csv: number };
  root: string;
  published: boolean | null;
};
type SaleType = 'allowlist_public' | 'public' | 'allowlist';

const SALE_TYPES: Array<{ id: SaleType; label: string; text: string }> = [
  { id: 'allowlist_public', label: 'Allowlist + Public', text: 'Your list mints first, then everyone.' },
  { id: 'public', label: 'Public only', text: 'Anyone can mint from the start.' },
  { id: 'allowlist', label: 'Allowlist only', text: 'Only the wallets on your list.' },
];

const INPUT =
  'h-[42px] w-full rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] px-[11px] font-sans text-[14px] text-white outline-none focus:border-sun';

/** Wei for a typed ETH price, "0" allowed (free mint); null when it is not a price. */
function priceWei(text: string): string | null {
  const t = text.trim();
  if (!/^[0-9]{1,7}(\.[0-9]{1,18})?$/.test(t)) return null;
  try {
    return parseEther(t).toString();
  } catch {
    return null;
  }
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="grid gap-[12px] rounded-[12px] border border-[#23242a] bg-[#0d0d0e] p-[14px]">
      <div className="flex items-center justify-between gap-[10px]">
        <h2 className="m-0 font-sans text-[14px] font-semibold text-white">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Label({ text, children }: { text: string; children: ReactNode }) {
  return (
    <label className="grid gap-[5px]">
      <span className="font-sans text-[10.5px] uppercase tracking-wide text-[#a9a9a9]">{text}</span>
      {children}
    </label>
  );
}

/** "Mint price 0.05 ETH, Flizy fee 0.001 ETH, Creator receives 0.049 ETH": no hidden fee. */
function FeeLine({ wei }: { wei: string | null }) {
  if (wei == null) return <span className="font-sans text-[11px] text-[#d9a24a]">Enter a price in ETH (0 for a free mint).</span>;
  const f = feeBreakdown(wei, 1);
  if (f.free) return <span className="font-sans text-[11px] text-[#8d8d8d]">Free mint: no Flizy fee, nothing to pay but network gas.</span>;
  return (
    <span className="grid gap-[2px] rounded-[6px] bg-[#0b0b0c] p-[8px] font-sans text-[11px] text-[#a9a9a9]">
      <span>
        Mint price <span className="text-white">{ethFromWei(f.totalWei)} ETH</span>
      </span>
      <span>
        Flizy fee (2%) <span className="text-white">{ethFromWei(f.feeWei)} ETH</span>
      </span>
      <span>
        You receive <span className="text-white">{ethFromWei(f.creatorWei)} ETH</span> per NFT
      </span>
    </span>
  );
}

type Sheet =
  | { kind: 'configure'; body: Record<string, unknown> }
  | { kind: 'publish' }
  | { kind: 'pause'; paused: boolean };

/**
 * Manage one Flizy-managed drop: overview, the mint schedule (allowlist,
 * public, end), the allowlist (Flizy usernames, wallets, CSV), and pause.
 * Every on-chain change goes through the confirm sheet with the password.
 */
export function MintManage({ collection }: { collection: string }) {
  const [drop, setDrop] = useState<MintDrop | null>(null);
  const [isCreator, setIsCreator] = useState<boolean | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [list, setList] = useState<Allowlist | null>(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<Sheet | null>(null);

  // Schedule form
  const [saleType, setSaleType] = useState<SaleType>('allowlist_public');
  const [alStart, setAlStart] = useState('');
  const [alEnd, setAlEnd] = useState('');
  const [alPrice, setAlPrice] = useState('0.02');
  const [pubStart, setPubStart] = useState('');
  const [pubPrice, setPubPrice] = useState('0.04');
  const [pubLimit, setPubLimit] = useState('5');
  const [mintEnd, setMintEnd] = useState('');
  const [formReady, setFormReady] = useState(false);

  // Allowlist form
  const [people, setPeople] = useState('');
  const [allowance, setAllowance] = useState('1');
  const [listBusy, setListBusy] = useState(false);
  const [listNote, setListNote] = useState('');

  const load = useCallback(async () => {
    try {
      const [detailRes, mineRes] = await Promise.all([fetch(`/api/mints/${collection}`), fetch('/api/mints/mine')]);
      const detail = await detailRes.json().catch(() => ({}));
      const mine = await mineRes.json().catch(() => ({}));
      if (!detailRes.ok || !detail.drop) throw new Error(detail.error || 'This collection does not mint through Flizy.');
      setDrop(detail.drop as MintDrop);
      setIsCreator(Boolean(detail.isCreator));
      const mineDrop = Array.isArray(mine.drops) ? mine.drops.find((x: { collection: string }) => x.collection === detail.drop.collection) : null;
      setStats(mineDrop?.stats ?? null);
      if (detail.isCreator && detail.drop.mode === 'flizy') {
        const al = await fetch(`/api/mints/${collection}/allowlist`).then((r) => r.json());
        if (Array.isArray(al.entries)) setList(al as Allowlist);
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this mint.');
    }
  }, [collection]);

  useEffect(() => {
    load();
  }, [load]);

  // Fill the form once from the drop on chain, or with a sensible first schedule.
  useEffect(() => {
    if (!drop || formReady) return;
    const c = drop.config;
    if (c) {
      setSaleType(c.allowlistStart && c.publicStart ? 'allowlist_public' : c.allowlistStart ? 'allowlist' : 'public');
      setAlStart(secToUtcInput(c.allowlistStart));
      setAlEnd(secToUtcInput(c.allowlistEnd));
      setAlPrice(ethFromWei(c.allowlistPriceWei)?.replace(/,/g, '') ?? '0');
      setPubStart(secToUtcInput(c.publicStart));
      setPubPrice(ethFromWei(c.publicPriceWei)?.replace(/,/g, '') ?? '0');
      setPubLimit(String(c.publicLimit || 5));
      setMintEnd(secToUtcInput(c.mintEnd));
    } else {
      const hour = 3600;
      const base = Math.ceil(Date.now() / 1000 / hour) * hour + hour;
      setAlStart(secToUtcInput(base));
      setAlEnd(secToUtcInput(base + 24 * hour));
      setPubStart(secToUtcInput(base + 24 * hour));
      setMintEnd(secToUtcInput(base + 8 * 24 * hour));
    }
    setFormReady(true);
  }, [drop, formReady]);

  const hasAllowlist = saleType !== 'public';
  const hasPublic = saleType !== 'allowlist';
  const alWei = priceWei(alPrice);
  const pubWei = priceWei(pubPrice);
  const configBody = useMemo(
    () => ({
      saleType,
      allowlistStart: hasAllowlist ? utcInputToSec(alStart) : 0,
      allowlistEnd: hasAllowlist ? utcInputToSec(alEnd) : 0,
      allowlistPrice: hasAllowlist ? alPrice.trim() : '0',
      publicStart: hasPublic ? utcInputToSec(pubStart) : 0,
      publicPrice: hasPublic ? pubPrice.trim() : '0',
      publicLimit: hasPublic ? Number(pubLimit) : 0,
      mintEnd: utcInputToSec(mintEnd),
    }),
    [saleType, hasAllowlist, hasPublic, alStart, alEnd, alPrice, pubStart, pubPrice, pubLimit, mintEnd]
  );
  const scheduleOk =
    (!hasAllowlist || (configBody.allowlistStart > 0 && configBody.allowlistEnd > configBody.allowlistStart && alWei != null)) &&
    (!hasPublic || (configBody.publicStart > 0 && pubWei != null && Number.isInteger(configBody.publicLimit) && configBody.publicLimit >= 1));

  async function addPeople(text: string, csv: boolean) {
    setListBusy(true);
    setListNote('');
    try {
      const res = await fetch(`/api/mints/${collection}/allowlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, csv, allowance: Number(allowance) || 1 }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setListNote(body.error || 'Could not add them.');
        return;
      }
      const notes: string[] = [`Added ${body.added}.`];
      if (body.unknownUsernames?.length) notes.push(`No Flizy account for: ${body.unknownUsernames.map((u: string) => `@${u}`).join(', ')}.`);
      if (body.errors?.length) notes.push(`Skipped: ${body.errors.join('; ')}.`);
      setListNote(notes.join(' '));
      if (!csv) setPeople('');
      load();
    } catch {
      setListNote('Could not add them.');
    } finally {
      setListBusy(false);
    }
  }

  async function remove(key: string) {
    setListBusy(true);
    try {
      const res = await fetch(`/api/mints/${collection}/allowlist`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: [key] }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setListNote(body.error || 'Could not remove it.');
      }
      load();
    } finally {
      setListBusy(false);
    }
  }

  function exportCsv() {
    if (!list) return;
    // The same entries the page shows: usernames stay usernames, so the file re-imports as is.
    const rows = ['entry,allowance', ...list.entries.map((e) => `${e.label},${e.allowance}`)];
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${drop?.name.replace(/[^A-Za-z0-9]+/g, '-') || 'allowlist'}-allowlist.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (error) return <p className="alert alert-error m-0">{error}</p>;
  if (!drop) return <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">Loading...</p>;
  if (!isCreator) return <p className="m-0 font-sans text-[12px] text-[#a9a9a9]">Only the creator can manage this mint.</p>;
  if (drop.contractManaged) {
    return (
      <p className="m-0 font-sans text-[12.5px] leading-[18px] text-[#d6d6d6]">
        This collection is Contract-managed: its own contract sets the price, limits and schedule, and Flizy cannot change them.{' '}
        <Link href={`/dashboard/explore/nfts/mint/${drop.collection}`} className="text-sun no-underline">
          View the mint page
        </Link>
      </p>
    );
  }

  const configured = drop.config != null;
  const remaining = drop.maxSupply != null ? Math.max(0, drop.maxSupply - drop.minted) : null;

  return (
    <div className="grid gap-[14px]">
      <div className="flex items-start justify-between gap-[10px]">
        <div className="min-w-0">
          <h1 className="m-0 truncate font-sans text-[20px] font-bold text-white">{drop.name}</h1>
          <p className="m-0 mt-[3px] font-mono text-[11px] text-[#a9a9a9]">{shortAddr(drop.collection)}</p>
        </div>
        <MintStatusPill status={drop.status} contractManaged={false} />
      </div>

      <Section
        title="Overview"
        aside={
          <Link href={`/dashboard/explore/nfts/mint/${drop.collection}`} className="font-sans text-[12px] text-sun no-underline">
            View mint page
          </Link>
        }
      >
        <div className="grid grid-cols-2 gap-[12px]">
          <Stat label="Minted" value={drop.minted.toLocaleString('en-US')} />
          <Stat label="Remaining" value={remaining == null ? '-' : remaining.toLocaleString('en-US')} />
          <Stat label="Revenue to you" value={stats ? `${ethFromWei(stats.revenueWei)} ETH` : '0 ETH'} />
          <Stat label="Mints today" value={String(stats?.mintsToday ?? 0)} />
        </div>
        {stats && BigInt(stats.feesWei) > 0n ? (
          <p className="m-0 font-sans text-[11px] text-[#8d8d8d]">Flizy fees so far: {ethFromWei(stats.feesWei)} ETH (2% of paid mints).</p>
        ) : null}
      </Section>

      <Section title="Mint schedule">
        <div className="grid gap-[6px]" role="radiogroup" aria-label="How do you want to sell?">
          {SALE_TYPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={saleType === s.id}
              onClick={() => setSaleType(s.id)}
              className={`grid gap-[2px] rounded-[8px] border p-[10px] text-left ${saleType === s.id ? 'border-sun' : 'border-[#2a2b30]'}`}
            >
              <span className={`font-sans text-[13px] font-semibold ${saleType === s.id ? 'text-sun' : 'text-white'}`}>{s.label}</span>
              <span className="font-sans text-[11px] text-[#a9a9a9]">{s.text}</span>
            </button>
          ))}
        </div>
        <p className="m-0 font-sans text-[11px] text-[#8d8d8d]">Times are in UTC, so you and your minters read the same clock.</p>

        {hasAllowlist ? (
          <div className="grid gap-[10px] rounded-[8px] border border-[#23242a] p-[11px]">
            <span className="font-sans text-[12.5px] font-semibold text-white">01 Allowlist</span>
            <div className="grid grid-cols-2 gap-[8px]">
              <Label text="Opens (UTC)">
                <input type="datetime-local" className={INPUT} value={alStart} onChange={(e) => setAlStart(e.target.value)} />
              </Label>
              <Label text="Closes (UTC)">
                <input type="datetime-local" className={INPUT} value={alEnd} onChange={(e) => setAlEnd(e.target.value)} />
              </Label>
            </div>
            <Label text="Price per NFT (ETH)">
              <input className={INPUT} inputMode="decimal" value={alPrice} onChange={(e) => setAlPrice(e.target.value)} />
            </Label>
            <FeeLine wei={alWei} />
            <span className="font-sans text-[11px] text-[#8d8d8d]">Each wallet on the list mints up to the allowance you give it below.</span>
          </div>
        ) : null}

        {hasPublic ? (
          <div className="grid gap-[10px] rounded-[8px] border border-[#23242a] p-[11px]">
            <span className="font-sans text-[12.5px] font-semibold text-white">{hasAllowlist ? '02 Public mint' : '01 Public mint'}</span>
            <Label text="Opens (UTC)">
              <input type="datetime-local" className={INPUT} value={pubStart} onChange={(e) => setPubStart(e.target.value)} />
            </Label>
            <div className="grid grid-cols-2 gap-[8px]">
              <Label text="Price per NFT (ETH)">
                <input className={INPUT} inputMode="decimal" value={pubPrice} onChange={(e) => setPubPrice(e.target.value)} />
              </Label>
              <Label text="Max per wallet">
                <input className={INPUT} inputMode="numeric" value={pubLimit} onChange={(e) => setPubLimit(e.target.value.replace(/[^0-9]/g, ''))} />
              </Label>
            </div>
            <FeeLine wei={pubWei} />
          </div>
        ) : null}

        <div className="grid gap-[8px] rounded-[8px] border border-[#23242a] p-[11px]">
          <span className="font-sans text-[12.5px] font-semibold text-white">{hasAllowlist && hasPublic ? '03' : '02'} Mint ends</span>
          <Label text="Ends (UTC), empty for at sellout">
            <input type="datetime-local" className={INPUT} value={mintEnd} onChange={(e) => setMintEnd(e.target.value)} />
          </Label>
        </div>

        <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
          Mint revenue goes to your Flizy wallet. {configured ? 'Saving applies to the live mint at once.' : ''}
          {hasAllowlist ? ' Saving also publishes your allowlist as it is now.' : ''}
        </p>
        <button
          type="button"
          disabled={!scheduleOk}
          onClick={() => setSheet({ kind: 'configure', body: configBody })}
          className="btn-sun h-[44px] rounded-[6px] font-sans text-[13.5px] font-semibold disabled:opacity-50"
        >
          {configured ? 'Save changes' : 'Set up the mint'}
        </button>
      </Section>

      {hasAllowlist || (list && list.wallets > 0) ? (
        <Section
          title="Allowlist"
          aside={
            list ? (
              <span className={`font-sans text-[11px] ${list.published ? 'text-sun' : 'text-[#d9a24a]'}`}>
                {list.published ? 'Live on chain' : configured ? 'Changes not published' : 'Publishes with the schedule'}
              </span>
            ) : null
          }
        >
          {list ? (
            <div className="grid grid-cols-3 gap-[8px] font-sans text-[11px] text-[#a9a9a9]">
              <span>
                Flizy users <span className="block text-[14px] text-white">{list.bySource.username}</span>
              </span>
              <span>
                Wallets <span className="block text-[14px] text-white">{list.bySource.address}</span>
              </span>
              <span>
                From CSV <span className="block text-[14px] text-white">{list.bySource.csv}</span>
              </span>
            </div>
          ) : null}
          <Label text="Add people">
            <textarea
              className="min-h-[86px] w-full rounded-[6px] border border-[#2a2b30] bg-[#0b0b0c] p-[11px] font-sans text-[14px] text-white outline-none focus:border-sun"
              value={people}
              onChange={(e) => setPeople(e.target.value)}
              placeholder={'@john\n@alice 2\n0x...'}
            />
          </Label>
          <span className="font-sans text-[11px] leading-[15px] text-[#8d8d8d]">
            Flizy usernames or wallet addresses, one per line. Add a number for more than the default: @alice 2. A username is
            matched to that person&apos;s Flizy wallet when you add it.
          </span>
          <div className="flex flex-wrap items-end gap-[8px]">
            <Label text="Default allowance">
              <input className={`${INPUT} w-[90px]`} inputMode="numeric" value={allowance} onChange={(e) => setAllowance(e.target.value.replace(/[^0-9]/g, ''))} />
            </Label>
            <button type="button" disabled={listBusy || !people.trim()} onClick={() => addPeople(people, false)} className="btn-sun h-[42px] rounded-[6px] px-[16px] font-sans text-[13px] disabled:opacity-50">
              Add
            </button>
            <label className="hit-y-44 inline-flex h-[42px] cursor-pointer items-center rounded-[6px] border border-[#3a3b40] px-[12px] font-sans text-[12.5px] text-white hover:border-sun">
              Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  if (file.size > 200_000) {
                    setListNote('That file is too big for one upload.');
                    return;
                  }
                  await addPeople(await file.text(), true);
                }}
              />
            </label>
            {list && list.wallets > 0 ? (
              <button type="button" onClick={exportCsv} className="hit-y-44 h-[42px] rounded-[6px] border border-[#3a3b40] px-[12px] font-sans text-[12.5px] text-white hover:border-sun">
                Export
              </button>
            ) : null}
          </div>
          {listNote ? <p className="m-0 font-sans text-[11.5px] text-[#d6d6d6]">{listNote}</p> : null}

          {list && list.entries.length > 0 ? (
            <ul className="m-0 grid max-h-[300px] list-none gap-[4px] overflow-y-auto p-0">
              {list.entries.map((e) => (
                <li key={e.key} className="flex items-center justify-between gap-[8px] rounded-[6px] bg-[#0b0b0c] px-[10px] py-[6px]">
                  <span className="min-w-0 truncate font-sans text-[12px] text-white">
                    {e.source === 'username' ? e.label : <span className="font-mono">{shortAddr(e.label)}</span>}
                    <span className="ml-[6px] text-[#a9a9a9]">x{e.allowance}</span>
                  </span>
                  <button type="button" onClick={() => remove(e.key)} disabled={listBusy} aria-label={`Remove ${e.label}`} className="hit-44 text-[#a9a9a9] hover:text-white">
                    <TrashIcon size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 font-sans text-[11.5px] text-[#a9a9a9]">Nobody on the list yet.</p>
          )}
          {list && configured && !list.published ? (
            <button type="button" onClick={() => setSheet({ kind: 'publish' })} className="btn-sun h-[42px] rounded-[6px] font-sans text-[13px]">
              Publish allowlist ({list.wallets} wallet{list.wallets === 1 ? '' : 's'})
            </button>
          ) : null}
        </Section>
      ) : null}

      {configured ? (
        <Section title="Controls">
          <p className="m-0 font-sans text-[11.5px] text-[#a9a9a9]">
            Pausing stops new mints at once. Everything already minted stays where it is.
          </p>
          <button
            type="button"
            onClick={() => setSheet({ kind: 'pause', paused: drop.status !== 'paused' })}
            className="h-[42px] rounded-[6px] border border-[#3a3b40] font-sans text-[13px] text-white hover:border-sun"
          >
            {drop.status === 'paused' ? 'Resume mint' : 'Pause mint'}
          </button>
        </Section>
      ) : null}

      {sheet?.kind === 'configure' ? (
        <MintActionSheet
          title={configured ? 'Save mint changes' : 'Set up the mint'}
          subtitle={drop.name}
          confirmLabel={configured ? 'Save changes' : 'Set up the mint'}
          url={`/api/mints/${drop.collection}/configure`}
          body={sheet.body}
          onClose={() => setSheet(null)}
          onDone={() => {
            setFormReady(false);
            load();
          }}
        >
          <div className="grid gap-[7px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[12px]">
            <SheetRow label="Sale" value={SALE_TYPES.find((s) => s.id === saleType)?.label} />
            {hasAllowlist && alWei != null ? (
              <SheetRow label="Allowlist price" value={alWei === '0' ? 'Free mint' : <EthAmount wei={alWei} />} />
            ) : null}
            {hasPublic && pubWei != null ? (
              <>
                <SheetRow label="Public price" value={pubWei === '0' ? 'Free mint' : <EthAmount wei={pubWei} />} />
                <SheetRow label="Max per wallet" value={pubLimit} />
              </>
            ) : null}
            <SheetRow label="Flizy fee" value="2% of each paid mint" />
            {hasAllowlist ? <SheetRow label="Allowlist" value={`${list?.wallets ?? 0} wallets, published with this`} /> : null}
            <div className="my-[2px] h-px bg-[#23242a]" />
            <SheetRow label="Cost" value="Network gas only" strong />
          </div>
        </MintActionSheet>
      ) : null}
      {sheet?.kind === 'publish' && list ? (
        <MintActionSheet
          title="Publish allowlist"
          subtitle={drop.name}
          confirmLabel="Publish allowlist"
          url={`/api/mints/${drop.collection}/publish`}
          body={{}}
          onClose={() => setSheet(null)}
          onDone={() => load()}
        >
          <div className="grid gap-[7px] rounded-[8px] border border-[#23242a] bg-[#0b0b0c] p-[12px]">
            <SheetRow label="Wallets" value={list.wallets} />
            <SheetRow label="NFTs they may mint" value={list.tokens} />
            <div className="my-[2px] h-px bg-[#23242a]" />
            <SheetRow label="Cost" value="Network gas only" strong />
          </div>
          <p className="m-0 font-sans text-[11px] leading-[16px] text-[#8d8d8d]">
            The list goes live on chain at once. Wallets taken off the list can no longer mint in the allowlist phase.
          </p>
        </MintActionSheet>
      ) : null}
      {sheet?.kind === 'pause' ? (
        <MintActionSheet
          title={sheet.paused ? 'Pause mint' : 'Resume mint'}
          subtitle={drop.name}
          confirmLabel={sheet.paused ? 'Pause mint' : 'Resume mint'}
          url={`/api/mints/${drop.collection}/pause`}
          body={{ paused: sheet.paused }}
          onClose={() => setSheet(null)}
          onDone={() => load()}
        >
          <SheetRow label="Cost" value="Network gas only" strong />
        </MintActionSheet>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="grid gap-[2px]">
      <span className="font-sans text-[10.5px] uppercase tracking-wide text-[#a9a9a9]">{label}</span>
      <span className="font-sans text-[17px] font-semibold text-white">{value}</span>
    </span>
  );
}
