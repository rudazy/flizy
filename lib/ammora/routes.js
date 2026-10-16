/**
 * Quotes and prepared swaps from the Ammora SDK, for Flizy's executor to send.
 *
 * The SDK's route client accepts only pools with on-chain provenance, which
 * the bot's discovery job stores in ammora_pools (lib/ammora/inventory.js).
 * The client is built from those rows and kept for ROUTE_TTL_MS, or until the
 * set of pools changes. The SDK never signs or sends: prepareExactIn returns a
 * transaction and approval requirements, and lib/ammora/execute.js sends them
 * through executeGatorCall.
 *
 * Mirror: web/lib/ammora/routes.ts. test/ammoraVenueDrift.test.js.
 */

const { createPublicClient, http, defineChain } = require('viem');
const { loadAmmoraSdk } = require('./sdk');
const { AMMORA_CHAIN_ID, NATIVE } = require('./venue');

const ROUTE_TTL_MS = 10 * 60_000;
const TABLE = 'ammora_pools';

const giwaSepolia = defineChain({
  id: AMMORA_CHAIN_ID,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
});

function rpcUrl() {
  return process.env.GIWA_RPC || process.env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io';
}

let clientForTests = null;

function viemClient() {
  if (clientForTests) return clientForTests;
  return createPublicClient({ chain: giwaSepolia, transport: http(rpcUrl(), { timeout: 30_000 }) });
}

/** One inventory row as the rest of Flizy sees it. */
function fromRow(r) {
  return {
    pool: r.pool,
    model: r.model,
    baseToken: r.base_token,
    quoteToken: r.quote_token,
    factory: r.factory,
    factoryId: r.factory_id,
    creationBlock: BigInt(r.creation_block),
    creationTransaction: r.creation_tx,
    creationLogIndex: Number(r.creation_log_index),
    runtimeCodeHash: r.runtime_code_hash,
    verifiedAtBlock: BigInt(r.verified_at_block),
    name: r.token_name,
    symbol: r.token_symbol,
    decimals: r.token_decimals == null ? null : Number(r.token_decimals),
    launchStatus: r.launch_status,
    tradable: Boolean(r.tradable),
  };
}

/** The SDK's AmmoraDiscoveredPool for one stored row, exactly as discovered. */
function toDiscoveredPool(t) {
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
    source: 'rpc',
  };
}

/** Rows per read. Supabase returns at most its max-rows setting (1,000 by default) per request, silently. */
const PAGE = 1000;
/** Anyone can launch on Ammora; past this many pools, the oldest are read. */
const MAX_POOLS = 5000;

/** Every stored pool, read in pages. Throws when the table cannot be read. */
async function loadInventory(supabase) {
  const rows = [];
  for (let from = 0; from < MAX_POOLS; from += PAGE) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('chain_id', AMMORA_CHAIN_ID)
      .order('discovered_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows.map(fromRow);
}

let cached = null;

/**
 * A route client for the stored pools, reused while fresh.
 * @returns {Promise<{ routes: object, inventory: object[] }>}
 */
async function getRouteClient(supabase, { now = Date.now(), inventory } = {}) {
  const pools = inventory || (await loadInventory(supabase));
  const key = pools.map((p) => p.pool).sort().join(',');
  if (cached && cached.key === key && now - cached.at < ROUTE_TTL_MS) return { routes: cached.routes, inventory: pools };
  const sdk = await loadAmmoraSdk();
  const client = viemClient();
  const routes = await sdk.AmmoraRouteClient.create({
    client,
    routeCatalog: sdk.giwaSepoliaAutoRouteCatalog,
    deploymentCatalog: sdk.giwaSepoliaAutoRouteDeploymentCatalog,
    factoryProfiles: sdk.giwaSepoliaAutoRoutePoolProfiles,
    aggregationPools: pools.filter((p) => p.model === 'dbc').map(toDiscoveredPool),
    verificationBlock: await client.getBlockNumber(),
  });
  cached = { key, at: now, routes };
  return { routes, inventory: pools };
}

function resetRouteClient() {
  cached = null;
}

/** Tests read the chain through a stub; null restores the real client. */
function setViemClientForTests(client) {
  clientForTests = client;
  cached = null;
}

/** SDK refusals that mean "this token is not tradable on Ammora right now". */
const NOT_TRADABLE = ['ARLORA_CONTRACT_UNSUPPORTED_TOKEN', 'AMMORA_SDK_ROUTE_UNAVAILABLE', 'AMMORA_SDK_UNVERIFIED_DEPLOYMENT'];

class AmmoraQuoteError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'AmmoraQuoteError';
    this.reason = reason;
  }
}

function asQuoteError(err) {
  const code = err && err.code ? String(err.code) : '';
  if (NOT_TRADABLE.includes(code)) return new AmmoraQuoteError('not_tradable', 'Not tradable on Ammora right now');
  return new AmmoraQuoteError('unavailable', 'Ammora quote unavailable');
}

/**
 * Exact-input quote. tokenIn / tokenOut null for native ETH.
 * @returns {Promise<object>} the SDK quote
 */
async function quoteAmmora(routes, { tokenIn, tokenOut, amountIn, slippageBps, recipient }) {
  try {
    return await routes.quoteExactIn({
      tokenIn: tokenIn || NATIVE,
      tokenOut: tokenOut || NATIVE,
      amountIn: BigInt(amountIn),
      slippageBps,
      recipient,
    });
  } catch (err) {
    throw asQuoteError(err);
  }
}

/**
 * The transaction and approvals for a quote, paid and received by the
 * account's smart account. Account-abstraction mode with direct approvals:
 * Flizy sends each approval and the swap as its own UserOp.
 */
async function prepareAmmora(routes, quote, payer) {
  try {
    const prepared = await routes.prepareExactIn(quote, {
      payer,
      recipient: payer,
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

module.exports = {
  fromRow,
  loadInventory,
  getRouteClient,
  resetRouteClient,
  quoteAmmora,
  prepareAmmora,
  AmmoraQuoteError,
  viemClient,
  setViemClientForTests,
};
