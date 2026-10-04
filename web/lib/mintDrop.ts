/**
 * Flizy Mint: the FlizyDrop contract as the site sees it.
 *
 * The chain is the source of truth for a Flizy-managed drop: phases, prices,
 * limits and the published allowlist root all live in FlizyDrop. This module
 * reads them, turns them into one status the pages can show, and checks a
 * creator's schedule with the same rules the contract enforces, so a bad
 * schedule is refused with a clear message before any transaction is sent.
 *
 * The pure parts (config parsing, phase status, fee breakdown, schedule
 * checks, event decoding) take no network and are what test/mintDrop.test.js
 * covers.
 */

import { ethers } from 'ethers';
import type { RawLog } from './nftIndex.ts';

/** Must match FlizyDrop.FEE_BPS. A test reads the contract source to keep them equal. */
export const MINT_FEE_BPS = 200;
/** Must match FlizyDrop.MAX_PER_TX. */
export const MAX_PER_TX = 20;
/** Must match FlizyCollection.MAX_SUPPLY_CAP. */
export const NATIVE_MAX_SUPPLY = 10_000;
/** Must match FlizyCollection.MAX_ROYALTY_BPS. */
export const NATIVE_MAX_ROYALTY_BPS = 1000;

const CONFIG_TUPLE =
  'tuple(uint64 allowlistStart, uint64 allowlistEnd, uint64 publicStart, uint64 mintEnd, uint128 allowlistPrice, uint128 publicPrice, uint32 publicLimit, bytes32 merkleRoot, address payout)';

export const DROP_ABI = [
  `function configure(address collection, ${CONFIG_TUPLE} config)`,
  'function setMerkleRoot(address collection, bytes32 root)',
  'function setDropPaused(address collection, bool value)',
  'function mintAllowlist(address collection, uint256 quantity, uint256 allowance, bytes32[] proof) payable returns (uint256)',
  'function mintPublic(address collection, uint256 quantity) payable returns (uint256)',
  `function getDrop(address collection) view returns (${CONFIG_TUPLE} config, bool configured, bool dropPaused)`,
  'function allowlistMinted(address collection, address wallet) view returns (uint256)',
  'function publicMinted(address collection, address wallet) view returns (uint256)',
  'function paused() view returns (bool)',
  'event Minted(address indexed collection, address indexed wallet, bool allowlist, uint256 quantity, uint256 firstTokenId, uint256 paid, uint256 fee)',
];
export const DROP_IFACE = new ethers.Interface(DROP_ABI);

const FACTORY_ABI = [
  'function create(string name, string symbol, uint256 maxSupply, string image, uint96 royaltyBps) returns (address)',
  'function isFlizyCollection(address) view returns (bool)',
  'event CollectionCreated(address indexed collection, address indexed creator, string name, string symbol, uint256 maxSupply, uint96 royaltyBps)',
];
export const FACTORY_IFACE = new ethers.Interface(FACTORY_ABI);

export const MINTABLE_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function owner() view returns (address)',
  'function flizyMinter() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function image() view returns (string)',
];

export type MintConfig = { drop: string; fromBlock: number; factory: string | null };

/** The deployed FlizyDrop (and factory), or null when minting through Flizy is off. */
export function mintConfig(env: Record<string, string | undefined> = process.env): MintConfig | null {
  const raw = env.CHAIN_GIWA_SEPOLIA_DROP;
  if (!raw || !ethers.isAddress(raw)) return null;
  const from = Number(env.CHAIN_GIWA_SEPOLIA_DROP_FROM_BLOCK || 0);
  const factory = env.CHAIN_GIWA_SEPOLIA_COLLECTION_FACTORY;
  return {
    drop: ethers.getAddress(raw),
    fromBlock: Number.isSafeInteger(from) && from > 0 ? from : 0,
    factory: factory && ethers.isAddress(factory) ? ethers.getAddress(factory) : null,
  };
}

/** FlizyDrop.Config with times in unix seconds and prices as wei strings. */
export type DropConfig = {
  allowlistStart: number;
  allowlistEnd: number;
  publicStart: number;
  mintEnd: number;
  allowlistPriceWei: string;
  publicPriceWei: string;
  publicLimit: number;
  merkleRoot: string;
  payout: string;
};

export type DropChainState = {
  configured: boolean;
  dropPaused: boolean;
  globalPaused: boolean;
  config: DropConfig | null;
};

const ZERO_ROOT = `0x${'0'.repeat(64)}`;

/** Decode getDrop's tuple into plain values. */
export function parseConfig(raw: {
  allowlistStart: bigint;
  allowlistEnd: bigint;
  publicStart: bigint;
  mintEnd: bigint;
  allowlistPrice: bigint;
  publicPrice: bigint;
  publicLimit: bigint;
  merkleRoot: string;
  payout: string;
}): DropConfig {
  return {
    allowlistStart: Number(raw.allowlistStart),
    allowlistEnd: Number(raw.allowlistEnd),
    publicStart: Number(raw.publicStart),
    mintEnd: Number(raw.mintEnd),
    allowlistPriceWei: raw.allowlistPrice.toString(),
    publicPriceWei: raw.publicPrice.toString(),
    publicLimit: Number(raw.publicLimit),
    merkleRoot: String(raw.merkleRoot).toLowerCase(),
    payout: ethers.getAddress(raw.payout),
  };
}

/** The tuple configure() takes. */
export function configTuple(c: DropConfig) {
  return [
    BigInt(c.allowlistStart),
    BigInt(c.allowlistEnd),
    BigInt(c.publicStart),
    BigInt(c.mintEnd),
    BigInt(c.allowlistPriceWei),
    BigInt(c.publicPriceWei),
    BigInt(c.publicLimit),
    c.merkleRoot || ZERO_ROOT,
    ethers.getAddress(c.payout),
  ] as const;
}

// --------------------------------------------------------------- status

export type DropStatus = 'unconfigured' | 'paused' | 'upcoming' | 'allowlist' | 'public' | 'ended' | 'sold_out';

export type PhaseView = {
  status: DropStatus;
  allowlistLive: boolean;
  publicLive: boolean;
  /** Unix seconds of the next scheduled change (a phase opening or the mint ending), or null. */
  nextChangeAt: number | null;
};

/**
 * One status for the page, from the chain state, supply and the time. Mirrors
 * FlizyDrop: a phase is off when its start is 0, the allowlist runs
 * [allowlistStart, allowlistEnd), public runs [publicStart, mintEnd), and
 * mintEnd 0 means no end. When both phases are live, the status is 'public'
 * and both flags are set.
 */
export function phaseView(
  state: DropChainState,
  supply: { minted: number; max: number | null },
  nowSec: number
): PhaseView {
  const none: PhaseView = { status: 'unconfigured', allowlistLive: false, publicLive: false, nextChangeAt: null };
  if (!state.configured || !state.config) return none;
  const c = state.config;
  const ended = c.mintEnd !== 0 && nowSec >= c.mintEnd;
  const soldOut = supply.max != null && supply.max > 0 && supply.minted >= supply.max;
  const allowlistLive = !ended && c.allowlistStart !== 0 && nowSec >= c.allowlistStart && nowSec < c.allowlistEnd;
  const publicLive = !ended && c.publicStart !== 0 && nowSec >= c.publicStart;

  const upcoming = [c.allowlistStart, c.allowlistEnd, c.publicStart, c.mintEnd].filter((t) => t !== 0 && t > nowSec);
  const nextChangeAt = ended || soldOut || upcoming.length === 0 ? null : Math.min(...upcoming);

  let status: DropStatus;
  if (soldOut) status = 'sold_out';
  else if (ended) status = 'ended';
  else if (state.globalPaused || state.dropPaused) status = 'paused';
  else if (publicLive) status = 'public';
  else if (allowlistLive) status = 'allowlist';
  else {
    const starts = [c.allowlistStart, c.publicStart].filter((t) => t !== 0 && t > nowSec);
    status = starts.length ? 'upcoming' : 'ended';
  }
  const mintable = status === 'public' || status === 'allowlist';
  return { status, allowlistLive: mintable && allowlistLive, publicLive: mintable && publicLive, nextChangeAt };
}

/**
 * The price to headline: the live phase's, else the next phase to open, else
 * the public price. While both phases are live the public price is shown; an
 * allowlisted viewer sees their own price in the eligibility block.
 */
export function headlinePriceWei(c: DropConfig, allowlistLive: boolean, publicLive: boolean, now: number): string {
  if (publicLive) return c.publicPriceWei;
  if (allowlistLive) return c.allowlistPriceWei;
  const allowlistNext = c.allowlistStart !== 0 && now < c.allowlistStart;
  const publicNext = c.publicStart !== 0 && now < c.publicStart;
  if (allowlistNext && (!publicNext || c.allowlistStart <= c.publicStart)) return c.allowlistPriceWei;
  if (c.publicStart !== 0) return c.publicPriceWei;
  return c.allowlistPriceWei;
}

// ------------------------------------------------------------------ fee

export type FeeBreakdown = { totalWei: string; feeWei: string; creatorWei: string; free: boolean };

/** What a mint costs and where it goes. Same rounding as FlizyDrop (fee rounds down). */
export function feeBreakdown(priceWei: string | bigint, quantity: number): FeeBreakdown {
  const total = BigInt(priceWei) * BigInt(quantity);
  const fee = (total * BigInt(MINT_FEE_BPS)) / 10_000n;
  return { totalWei: total.toString(), feeWei: fee.toString(), creatorWei: (total - fee).toString(), free: total === 0n };
}

// ------------------------------------------------------------- schedule

export type ScheduleInput = {
  saleType: 'allowlist_public' | 'public' | 'allowlist';
  allowlistStart?: number;
  allowlistEnd?: number;
  publicStart?: number;
  mintEnd?: number;
  allowlistPriceWei?: string;
  publicPriceWei?: string;
  publicLimit?: number;
  payout: string;
  merkleRoot?: string;
};

export type ScheduleCheck = { ok: true; config: DropConfig } | { ok: false; error: string };

const MAX_PRICE_WEI = ethers.parseEther('1000000');
const MAX_TIME = 4_102_444_800; // 2100-01-01, well inside uint64

function time(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < MAX_TIME ? v : null;
}

function price(v: unknown): string | null {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(v)) return null;
  return BigInt(v) <= MAX_PRICE_WEI ? v : null;
}

/**
 * A creator's schedule turned into a DropConfig, refused with a message the
 * creator can act on when FlizyDrop would revert it. New phases must start in
 * the future only when `requireFuture` (a fresh drop); editing a live drop may
 * keep a start that has passed.
 */
export function checkSchedule(input: ScheduleInput, nowSec: number, requireFuture: boolean): ScheduleCheck {
  if (!ethers.isAddress(input.payout)) return { ok: false, error: 'Choose a payout address.' };
  const hasAllowlist = input.saleType !== 'public';
  const hasPublic = input.saleType !== 'allowlist';
  const mintEnd = input.mintEnd == null || input.mintEnd === 0 ? 0 : time(input.mintEnd);
  if (mintEnd == null) return { ok: false, error: 'The mint end time is not valid.' };

  let allowlistStart = 0;
  let allowlistEnd = 0;
  let allowlistPriceWei = '0';
  if (hasAllowlist) {
    const s = time(input.allowlistStart);
    const e = time(input.allowlistEnd);
    if (s == null || e == null) return { ok: false, error: 'Set when the allowlist opens and closes.' };
    if (e <= s) return { ok: false, error: 'The allowlist must close after it opens.' };
    if (mintEnd !== 0 && e > mintEnd) return { ok: false, error: 'The allowlist cannot close after the mint ends.' };
    if (requireFuture && s <= nowSec) return { ok: false, error: 'The allowlist must open in the future.' };
    const p = price(input.allowlistPriceWei ?? '0');
    if (p == null) return { ok: false, error: 'Enter a valid allowlist price.' };
    allowlistStart = s;
    allowlistEnd = e;
    allowlistPriceWei = p;
  }

  let publicStart = 0;
  let publicPriceWei = '0';
  let publicLimit = 0;
  if (hasPublic) {
    const s = time(input.publicStart);
    if (s == null) return { ok: false, error: 'Set when the public mint opens.' };
    if (mintEnd !== 0 && mintEnd <= s) return { ok: false, error: 'The mint must end after the public mint opens.' };
    if (requireFuture && s <= nowSec) return { ok: false, error: 'The public mint must open in the future.' };
    const p = price(input.publicPriceWei ?? '0');
    if (p == null) return { ok: false, error: 'Enter a valid public price.' };
    const limit = input.publicLimit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > NATIVE_MAX_SUPPLY) {
      return { ok: false, error: 'Set a per-wallet limit for the public mint.' };
    }
    publicStart = s;
    publicPriceWei = p;
    publicLimit = limit;
  }

  const root = (input.merkleRoot || ZERO_ROOT).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(root)) return { ok: false, error: 'The allowlist root is not valid.' };

  return {
    ok: true,
    config: {
      allowlistStart,
      allowlistEnd,
      publicStart,
      mintEnd,
      allowlistPriceWei,
      publicPriceWei,
      publicLimit,
      merkleRoot: root,
      payout: ethers.getAddress(input.payout),
    },
  };
}

// --------------------------------------------------------------- events

export type MintedEvent = {
  collection: string;
  wallet: string;
  allowlist: boolean;
  quantity: number;
  firstTokenId: string;
  paidWei: string;
  feeWei: string;
  blockNumber: number;
  txHash: string;
  timestamp: string | null;
};

const MINTED_TOPIC = DROP_IFACE.getEvent('Minted')!.topicHash;

export function decodeMintedLogs(logs: RawLog[]): MintedEvent[] {
  const out: MintedEvent[] = [];
  for (const log of logs) {
    if (!log.topics.length || log.topics[0].toLowerCase() !== MINTED_TOPIC) continue;
    let parsed;
    try {
      parsed = DROP_IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    out.push({
      collection: ethers.getAddress(parsed.args.collection),
      wallet: ethers.getAddress(parsed.args.wallet),
      allowlist: Boolean(parsed.args.allowlist),
      quantity: Number(parsed.args.quantity),
      firstTokenId: parsed.args.firstTokenId.toString(),
      paidWei: parsed.args.paid.toString(),
      feeWei: parsed.args.fee.toString(),
      blockNumber: log.blockNumber,
      txHash: log.txHash,
      timestamp: log.timestamp,
    });
  }
  return out;
}

export type MintStats = { revenueWei: string; feesWei: string; mintedViaFlizy: number; mintsToday: number };

/** Revenue to the creator, Flizy fees, tokens minted and mints in the last 24 hours, for one collection. */
export function mintStats(events: MintedEvent[], collection: string, nowMs: number): MintStats {
  const target = ethers.getAddress(collection);
  let revenue = 0n;
  let fees = 0n;
  let minted = 0;
  let today = 0;
  for (const e of events) {
    if (e.collection !== target) continue;
    revenue += BigInt(e.paidWei) - BigInt(e.feeWei);
    fees += BigInt(e.feeWei);
    minted += e.quantity;
    const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(at) && nowMs - at < 24 * 60 * 60 * 1000) today += e.quantity;
  }
  return { revenueWei: revenue.toString(), feesWei: fees.toString(), mintedViaFlizy: minted, mintsToday: today };
}

// ---------------------------------------------------------------- reads

/** Live drop state from FlizyDrop. */
export async function readDrop(provider: ethers.Provider, cfg: MintConfig, collection: string): Promise<DropChainState> {
  const drop = new ethers.Contract(cfg.drop, DROP_ABI, provider);
  const [result, globalPaused] = await Promise.all([drop.getDrop(collection), drop.paused()]);
  const configured = Boolean(result.configured);
  return {
    configured,
    dropPaused: Boolean(result.dropPaused),
    globalPaused: Boolean(globalPaused),
    config: configured ? parseConfig(result.config) : null,
  };
}

/** Supply of a Flizy-mintable collection: minted so far and the cap. */
export async function readSupply(provider: ethers.Provider, collection: string): Promise<{ minted: number; max: number | null }> {
  const c = new ethers.Contract(collection, MINTABLE_ABI, provider);
  const [minted, max] = await Promise.all([
    c.totalSupply().then((v: bigint) => Number(v)).catch(() => 0),
    c.maxSupply().then((v: bigint) => Number(v)).catch(() => null),
  ]);
  return { minted, max };
}
