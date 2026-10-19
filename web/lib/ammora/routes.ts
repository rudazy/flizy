/**
 * Quotes and prepared swaps from the Ammora SDK, for Flizy's executor to send.
 * Mirror of lib/ammora/routes.js: the route client is built from the pools the
 * bot discovered (ammora_pools), kept per serverless instance for
 * ROUTE_TTL_MS or until the pool set changes. The SDK is loaded on first use
 * only, so nothing Ammora runs while AMMORA_ENABLED is off.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createPublicClient, http, defineChain } from 'viem';
import { AMMORA_CHAIN_ID, NATIVE } from './venue.ts';
import { capSlippageBps } from '../swapGate.ts';

/** Used when a caller names none, mirrors lib/ammora/routes.js. */
const DEFAULT_SLIPPAGE_BPS = 100;

const ROUTE_TTL_MS = 10 * 60_000;
const TABLE = 'ammora_pools';

type Sdk = typeof import('@ammora-protocol/sdk');
let sdkPromise: Promise<Sdk> | null = null;

export function loadAmmoraSdk(): Promise<Sdk> {
  if (!sdkPromise) {
    sdkPromise = import('@ammora-protocol/sdk').catch((err) => {
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

/** Tests replace the SDK with a scripted one. */
export function setAmmoraSdkForTests(sdk: unknown): void {
  sdkPromise = sdk ? Promise.resolve(sdk as Sdk) : null;
}

const giwaSepolia = defineChain({
  id: AMMORA_CHAIN_ID,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
});

function rpcUrl(): string {
  return process.env.GIWA_RPC || process.env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io';
}

type ChainReader = { getBlockNumber(): Promise<bigint> };
let clientForTests: ChainReader | null = null;

export function viemClient() {
  if (clientForTests) return clientForTests as ReturnType<typeof createPublicClient>;
  return createPublicClient({ chain: giwaSepolia, transport: http(rpcUrl(), { timeout: 30_000 }) });
}

export type InventoryToken = {
  pool: string;
  model: string;
  baseToken: string;
  quoteToken: string;
  factory: string;
  factoryId: string;
  creationBlock: bigint;
  creationTransaction: string;
  creationLogIndex: number;
  runtimeCodeHash: string;
  verifiedAtBlock: bigint;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  launchStatus: string | null;
  tradable: boolean;
};

type Row = Record<string, unknown>;

export function fromRow(r: Row): InventoryToken {
  return {
    pool: String(r.pool),
    model: String(r.model),
    baseToken: String(r.base_token),
    quoteToken: String(r.quote_token),
    factory: String(r.factory),
    factoryId: String(r.factory_id),
    creationBlock: BigInt(String(r.creation_block)),
    creationTransaction: String(r.creation_tx),
    creationLogIndex: Number(r.creation_log_index),
    runtimeCodeHash: String(r.runtime_code_hash),
    verifiedAtBlock: BigInt(String(r.verified_at_block)),
    name: (r.token_name as string | null) ?? null,
    symbol: (r.token_symbol as string | null) ?? null,
    decimals: r.token_decimals == null ? null : Number(r.token_decimals),
    launchStatus: (r.launch_status as string | null) ?? null,
    tradable: Boolean(r.tradable),
  };
}

/** The SDK's AmmoraDiscoveredPool for one stored row, exactly as discovered. */
function toDiscoveredPool(t: InventoryToken) {
  return {
    model: t.model,
    pool: t.pool,
    baseToken: t.baseToken,
    quoteToken: t.quoteToken,
    factory: t.factory,
    factoryId: t.factoryId,
    creationBlock: t.creationBlock,
    creationTransaction: t.creationTransaction,
    creationLogIndex: t.creationLogIndex,
    runtimeCodeHash: t.runtimeCodeHash,
    verifiedAtBlock: t.verifiedAtBlock,
    source: 'rpc' as const,
  };
}

/** Rows per read. Supabase returns at most its max-rows setting (1,000 by default) per request, silently. */
const PAGE = 1000;
/** Anyone can launch on Ammora; past this many pools, the oldest are read. */
const MAX_POOLS = 5000;

/** Every stored pool, read in pages. Throws when the table cannot be read. */
export async function loadInventory(supabase: SupabaseClient): Promise<InventoryToken[]> {
  const rows: Row[] = [];
  for (let from = 0; from < MAX_POOLS; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('chain_id', AMMORA_CHAIN_ID)
      .order('discovered_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...((data || []) as Row[]));
    if (!data || data.length < PAGE) break;
  }
  return rows.map(fromRow);
}

type RouteClient = Awaited<ReturnType<Sdk['AmmoraRouteClient']['create']>>;
let cached: { key: string; at: number; routes: RouteClient } | null = null;

export async function getRouteClient(
  supabase: SupabaseClient,
  opts: { now?: number; inventory?: InventoryToken[] } = {}
): Promise<{ routes: RouteClient; inventory: InventoryToken[] }> {
  const now = opts.now ?? Date.now();
  const pools = opts.inventory || (await loadInventory(supabase));
  const key = pools.map((p) => p.pool).sort().join(',');
  if (cached && cached.key === key && now - cached.at < ROUTE_TTL_MS) return { routes: cached.routes, inventory: pools };
  const sdk = await loadAmmoraSdk();
  const client = viemClient();
  const routes = await sdk.AmmoraRouteClient.create({
    client: client as never,
    routeCatalog: sdk.giwaSepoliaAutoRouteCatalog,
    deploymentCatalog: sdk.giwaSepoliaAutoRouteDeploymentCatalog,
    factoryProfiles: sdk.giwaSepoliaAutoRoutePoolProfiles,
    aggregationPools: pools.filter((p) => p.model === 'dbc').map(toDiscoveredPool) as never,
    verificationBlock: await client.getBlockNumber(),
  });
  cached = { key, at: now, routes };
  return { routes, inventory: pools };
}

export function resetRouteClient(): void {
  cached = null;
}

/** Tests read the chain through a stub; null restores the real client. */
export function setViemClientForTests(client: ChainReader | null): void {
  clientForTests = client;
  cached = null;
}

/** SDK refusals that mean "this token is not tradable on Ammora right now". */
const NOT_TRADABLE = ['ARLORA_CONTRACT_UNSUPPORTED_TOKEN', 'AMMORA_SDK_ROUTE_UNAVAILABLE', 'AMMORA_SDK_UNVERIFIED_DEPLOYMENT'];

export class AmmoraQuoteError extends Error {
  readonly reason: 'not_tradable' | 'unavailable';
  constructor(reason: 'not_tradable' | 'unavailable', message: string) {
    super(message);
    this.name = 'AmmoraQuoteError';
    this.reason = reason;
  }
}

function asQuoteError(err: unknown): AmmoraQuoteError {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (NOT_TRADABLE.includes(code)) return new AmmoraQuoteError('not_tradable', 'Not tradable on Ammora right now');
  return new AmmoraQuoteError('unavailable', 'Ammora quote unavailable');
}

export type AmmoraQuote = Awaited<ReturnType<RouteClient['quoteExactIn']>>;

/** Exact-input quote. tokenIn / tokenOut null for native ETH. */
export async function quoteAmmora(
  routes: RouteClient,
  args: { tokenIn: string | null; tokenOut: string | null; amountIn: bigint; slippageBps?: number; recipient?: string }
): Promise<AmmoraQuote> {
  try {
    return await routes.quoteExactIn({
      tokenIn: (args.tokenIn || NATIVE) as `0x${string}`,
      tokenOut: (args.tokenOut || NATIVE) as `0x${string}`,
      amountIn: BigInt(args.amountIn),
      // Held to the same 5% cap as Flizy's own quotes; a missing figure is 1%,
      // so the SDK's own default never applies.
      slippageBps: capSlippageBps(args.slippageBps ?? DEFAULT_SLIPPAGE_BPS),
      recipient: args.recipient as `0x${string}` | undefined,
    });
  } catch (err) {
    throw asQuoteError(err);
  }
}

export type PreparedAmmoraSwap = {
  transaction: { to: string; data: string; value: bigint };
  approvalRequirements: Array<{ token: string; spender: string; amount: bigint; resetToZero: boolean }>;
  quote: AmmoraQuote;
};

/** The transaction and approvals for a quote, paid and received by the smart account. */
export async function prepareAmmora(routes: RouteClient, quote: AmmoraQuote, payer: string): Promise<PreparedAmmoraSwap> {
  try {
    const prepared = await routes.prepareExactIn(quote, {
      payer: payer as `0x${string}`,
      recipient: payer as `0x${string}`,
      executionMode: 'account-abstraction',
      funding: { kind: 'direct-approval' },
    });
    return {
      transaction: { to: prepared.transaction.to, data: prepared.transaction.data, value: BigInt(prepared.transaction.value || 0n) },
      approvalRequirements: prepared.approvalRequirements.map((r) => ({
        token: r.token,
        spender: r.spender,
        amount: BigInt(r.amount),
        resetToZero: Boolean(r.resetToZero),
      })),
      quote: prepared.quote,
    };
  } catch (err) {
    throw asQuoteError(err);
  }
}
