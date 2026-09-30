/**
 * DEX helpers for Flizy on GIWA Sepolia.
 * Router addresses come from chain registry / deployments config.
 * Swaps always go through the fee router (protocol fee disclosure required).
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { getChain, getDefaultChain } = require('./chains');
const { config } = require('./config');

const FEE_ROUTER_ABI = [
  'function feeBps() view returns (uint16)',
  'function MAX_FEE_BPS() view returns (uint16)',
  'function treasury() view returns (address)',
  'function v2Router() view returns (address)',
  'function quoteFee(uint256 amountIn) view returns (uint256 feeAmount, uint256 amountAfterFee)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
];

const V2_ROUTER_ABI = [
  'function WETH() view returns (address)',
  'function factory() view returns (address)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] memory amounts)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

const ERC20_META_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
];

const FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address pair)'];
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

let _deploymentsCache = null;

function loadDeployments() {
  if (_deploymentsCache) return _deploymentsCache;
  const p = path.join(__dirname, '..', 'deployments', 'giwa-sepolia.json');
  if (!fs.existsSync(p)) return null;
  _deploymentsCache = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _deploymentsCache;
}

/**
 * Resolve DEX addresses for a chain (registry + deployment file + env).
 * @param {string} [chainKey]
 */
function getDexConfig(chainKey) {
  const chain = getChain(chainKey || config.defaultChainKey);
  const dep = loadDeployments();
  const c = dep?.contracts || {};

  const wrappedNative =
    chain.wrappedNative ||
    process.env.CHAIN_GIWA_SEPOLIA_WETH ||
    c.weth ||
    '';
  const dexRouter =
    chain.dexRouter ||
    process.env.CHAIN_GIWA_SEPOLIA_DEX_ROUTER ||
    c.router ||
    '';
  const dexFactory =
    chain.dexFactory ||
    process.env.CHAIN_GIWA_SEPOLIA_DEX_FACTORY ||
    c.factory ||
    '';
  const feeRouter =
    chain.feeRouter ||
    process.env.CHAIN_GIWA_SEPOLIA_FEE_ROUTER ||
    c.feeRouter ||
    '';
  const flz =
    chain.flzToken ||
    process.env.CHAIN_GIWA_SEPOLIA_FLZ ||
    c.flz ||
    '';
  const pair =
    chain.flzWethPair ||
    process.env.CHAIN_GIWA_SEPOLIA_FLZ_WETH_PAIR ||
    c.pairFlzWeth ||
    '';

  const feeBpsDefault = Number(
    process.env.SWAP_FEE_BPS || dep?.feeBpsDefault || config.swapFeeBps || 30
  );
  const slippageBpsDefault = Number(process.env.SWAP_SLIPPAGE_BPS || config.swapSlippageBps || 100);

  return {
    chain,
    wrappedNative: wrappedNative ? ethers.getAddress(wrappedNative) : '',
    dexRouter: dexRouter ? ethers.getAddress(dexRouter) : '',
    dexFactory: dexFactory ? ethers.getAddress(dexFactory) : '',
    feeRouter: feeRouter ? ethers.getAddress(feeRouter) : '',
    flz: flz ? ethers.getAddress(flz) : '',
    pair: pair ? ethers.getAddress(pair) : '',
    feeBpsDefault,
    slippageBpsDefault,
    treasury: dep?.treasury || process.env.FLIZY_TREASURY || '',
  };
}

/**
 * Routers that Policy may allow as swap targets (never trusted-contacts).
 * @param {string} [chainKey]
 * @returns {Set<string>} lowercase addresses
 */
function getRouterAllowlist(chainKey) {
  const d = getDexConfig(chainKey);
  const set = new Set();
  if (d.feeRouter) set.add(d.feeRouter.toLowerCase());
  if (d.dexRouter) set.add(d.dexRouter.toLowerCase());
  return set;
}

function isAllowedSwapRouter(address, chainKey) {
  if (!address || !ethers.isAddress(address)) return false;
  return getRouterAllowlist(chainKey).has(ethers.getAddress(address).toLowerCase());
}

/**
 * Resolve token symbol to address (native, WETH, FLZ, or 0x address).
 * @param {string} symbolOrAddress
 * @param {string} [chainKey]
 */
function resolveToken(symbolOrAddress, chainKey) {
  const d = getDexConfig(chainKey);
  const raw = String(symbolOrAddress || '').trim();
  if (!raw) throw new Error('Token required');
  if (ethers.isAddress(raw)) return ethers.getAddress(raw);

  const s = raw.toUpperCase();
  if (s === 'ETH' || s === 'NATIVE') return null; // native
  if (s === 'WETH') {
    if (!d.wrappedNative) throw new Error('WETH not configured');
    return d.wrappedNative;
  }
  if (s === 'FLZ' || s === 'FLIZY') {
    if (!d.flz) throw new Error('FLZ not configured');
    return d.flz;
  }
  throw new Error(`Unknown token: ${raw}. Use ETH, FLZ, or a 0x address.`);
}

function tokenLabel(symbolOrAddress, chainKey) {
  const raw = String(symbolOrAddress || '').trim();
  if (!raw) return '?';
  if (/^eth$/i.test(raw) || /^native$/i.test(raw)) return 'ETH';
  if (/^flz$/i.test(raw) || /^flizy$/i.test(raw)) return 'FLZ';
  if (/^weth$/i.test(raw)) return 'WETH';
  if (ethers.isAddress(raw)) {
    const d = getDexConfig(chainKey);
    if (d.flz && ethers.getAddress(raw) === d.flz) return 'FLZ';
    if (d.wrappedNative && ethers.getAddress(raw) === d.wrappedNative) return 'WETH';
    return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
  }
  return raw.toUpperCase();
}

/** Symbols identity send / claim may use. No arbitrary 0x paste. */
function listedSendSymbols() {
  return ['ETH', 'FLZ'];
}

/**
 * True when either side of a swap is a token other than native, WETH or FLZ.
 * Mirrors isUnverifiedSwap in web/lib/swapGate.ts (test/swapGateDrift.test.js).
 * @param {Array<string|null>} sides resolved addresses; null is native
 * @param {string} [chainKey]
 */
function isUnverifiedSwap(sides, chainKey) {
  const d = getDexConfig(chainKey);
  const ok = [d.wrappedNative, d.flz].filter(Boolean).map((a) => a.toLowerCase());
  return sides.some((side) => side !== null && !ok.includes(String(side).toLowerCase()));
}

/** Shown when chat is asked to send a token Flizy has not verified. */
const SOCIAL_SEND_REFUSAL = `Only verified tokens can be sent on socials. Verified: ${listedSendSymbols()
  .filter((symbol) => symbol !== 'ETH')
  .join(', ')}. ETH still sends.`;

/**
 * Resolve a listed send/claim asset.
 * Rejects unknown symbols and raw contract paste — those stay swap-only.
 *
 * @param {string} raw
 * @param {string} [chainKey]
 * @returns {{ native: boolean, symbol: string, tokenAddress: string|null }}
 */
function resolveListedSendAsset(raw, chainKey) {
  const s = String(raw || 'ETH').trim().toUpperCase();
  const symbol = s === 'NATIVE' || s === 'ETHER' ? 'ETH' : s === 'FLIZY' ? 'FLZ' : s;
  if (symbol === 'ETH') {
    return { native: true, symbol: 'ETH', tokenAddress: null };
  }
  if (symbol === 'FLZ') {
    const tokenAddress = resolveToken('FLZ', chainKey);
    if (!tokenAddress) throw new Error('FLZ is not configured on this chain.');
    return { native: false, symbol: 'FLZ', tokenAddress };
  }
  throw new Error(SOCIAL_SEND_REFUSAL);
}

/**
 * Protocol fee math (basis points on amount in).
 * @param {bigint} amountIn
 * @param {number} feeBps
 */
function computeFee(amountIn, feeBps) {
  const fee = (amountIn * BigInt(feeBps)) / 10000n;
  return { feeAmount: fee, amountAfterFee: amountIn - fee };
}

/**
 * Apply slippage to amountOut (min acceptable).
 * @param {bigint} amountOut
 * @param {number} slippageBps
 */
function amountOutMin(amountOut, slippageBps) {
  return amountOut - (amountOut * BigInt(slippageBps)) / 10000n;
}

/**
 * Uniswap V2 exact-out: input needed to receive amountOut from one pool.
 * The 0.30% pool fee is baked into the 997/1000 ratio; +1 rounds in the pool's
 * favour so the quote is never a wei short of clearing.
 *
 * @param {bigint} amountOut
 * @param {bigint} reserveIn
 * @param {bigint} reserveOut
 * @returns {bigint} input before the protocol fee
 */
function amountInForExactOut(amountOut, reserveIn, reserveOut) {
  if (amountOut <= 0n) throw new Error('Amount must be greater than zero');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Empty pool');
  if (amountOut >= reserveOut) {
    throw new Error('Pool does not hold that much. Try a smaller amount.');
  }
  const numerator = reserveIn * amountOut * 1000n;
  const denominator = (reserveOut - amountOut) * 997n;
  return numerator / denominator + 1n;
}

/**
 * Inverse of computeFee: the input to send so that amountAfterFee survives.
 * The fee router takes feeBps off the input BEFORE swapping, so an exact-out
 * quote has to gross up or the pool receives too little to fill the order.
 *
 * @param {bigint} amountAfterFee
 * @param {number} feeBps
 * @returns {bigint}
 */
function grossUpForFee(amountAfterFee, feeBps) {
  const net = 10000n - BigInt(feeBps);
  if (net <= 0n) throw new Error('Swap fee misconfigured');
  return (amountAfterFee * 10000n + net - 1n) / net; // ceil
}

async function readFeeBps(provider, chainKey) {
  const d = getDexConfig(chainKey);
  if (!d.feeRouter) return d.feeBpsDefault;
  try {
    const c = new ethers.Contract(d.feeRouter, FEE_ROUTER_ABI, provider);
    return Number(await c.feeBps());
  } catch {
    return d.feeBpsDefault;
  }
}

/**
 * Quote a swap through the fee router (fee already subtracted in getAmountsOut).
 * @returns {Promise<object>}
 */
async function quoteSwap({
  provider,
  amountIn,
  tokenIn, // null = native ETH
  tokenOut, // null = native ETH
  chainKey,
  slippageBps,
}) {
  const d = getDexConfig(chainKey);
  if (!d.feeRouter || !d.wrappedNative) {
    throw new Error('DEX not configured for this chain');
  }
  const feeBps = await readFeeBps(provider, chainKey);
  const slip = slippageBps ?? d.slippageBpsDefault;

  const path = [];
  const inIsNative = tokenIn === null || tokenIn === undefined;
  const outIsNative = tokenOut === null || tokenOut === undefined;
  if (inIsNative) path.push(d.wrappedNative);
  else path.push(ethers.getAddress(tokenIn));
  if (outIsNative) path.push(d.wrappedNative);
  else path.push(ethers.getAddress(tokenOut));

  // same token path invalid
  if (path[0].toLowerCase() === path[path.length - 1].toLowerCase() && inIsNative === outIsNative) {
    throw new Error('Cannot swap a token for itself');
  }

  const feeRouter = new ethers.Contract(d.feeRouter, FEE_ROUTER_ABI, provider);
  const amounts = await feeRouter.getAmountsOut(amountIn, path);
  const amountOut = amounts[amounts.length - 1];
  const { feeAmount, amountAfterFee } = computeFee(amountIn, feeBps);
  const minOut = amountOutMin(amountOut, slip);

  return {
    path,
    amounts,
    amountIn,
    amountOut,
    amountOutMin: minOut,
    feeAmount,
    amountAfterFee,
    feeBps,
    slippageBps: slip,
    inIsNative,
    outIsNative,
    feeRouter: d.feeRouter,
    v2Router: d.dexRouter,
    chain: d.chain,
  };
}

/**
 * Pool reserves mapped onto a swap direction.
 *
 * Native is mapped to wrapped native, exactly the way quoteSwap builds its path,
 * so callers can pass the same null-means-ETH tokens they pass everywhere else.
 *
 * @param {object} provider
 * @param {{ tokenIn: string|null, tokenOut: string|null, chainKey?: string }} opts
 * @returns {Promise<{ reserveIn: bigint, reserveOut: bigint, pair: string }>}
 */
async function getPairReserves(provider, { tokenIn, tokenOut, chainKey }) {
  const d = getDexConfig(chainKey);
  if (!d.pair || !d.wrappedNative) throw new Error('Pair not configured');

  const inAddr = tokenIn == null ? d.wrappedNative : ethers.getAddress(tokenIn);
  const outAddr = tokenOut == null ? d.wrappedNative : ethers.getAddress(tokenOut);
  if (inAddr === outAddr) throw new Error('Cannot swap a token for itself');

  // The configured pool first, then the factory. Before pasted contracts this
  // only ever looked at d.pair and threw for anything else; the factory lookup
  // is what lets a token nobody listed be quoted, and a token with no pool at
  // all still fails loudly rather than being quoted against the wrong reserves.
  //
  // Which tokens the configured pool holds is known from config, so deciding
  // costs no round trip. Reading token0/token1 to find out would put two extra
  // calls on every FLZ quote -- the hot path -- to learn something already on
  // disk. The pair's real tokens are still checked below, against reserves.
  const configured = new Set([d.flz, d.wrappedNative].filter(Boolean));
  const isConfiguredPair =
    Boolean(d.pair) && configured.has(inAddr) && configured.has(outAddr);

  let pairAddress = d.pair;
  if (!isConfiguredPair) {
    pairAddress = await findPair(provider, inAddr, outAddr, chainKey);
    if (!pairAddress) throw new Error('No pool for that pair on this chain');
  }

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const [reserves, t0, t1] = await Promise.all([pair.getReserves(), pair.token0(), pair.token1()]);
  const token0 = ethers.getAddress(t0);
  const token1 = ethers.getAddress(t1);

  const inPool = new Set([token0, token1]);
  if (!inPool.has(inAddr) || !inPool.has(outAddr)) {
    throw new Error('No pool for that pair on this chain');
  }

  const [r0, r1] = reserves;
  return {
    reserveIn: inAddr === token0 ? r0 : r1,
    reserveOut: outAddr === token0 ? r0 : r1,
    pair: pairAddress,
  };
}

/**
 * How much input a desired output needs, for a single hop.
 *
 * The deployed router is a trimmed V2 fork with no getAmountsIn (see
 * contracts/src/dex/UniswapV2Library.sol) and the fee router only exposes
 * swapExact* entrypoints, so "buy 100 FLZ" is resolved to an input amount here,
 * off-chain. Execution still goes down the ordinary exact-in path: this is a
 * quoting convenience, not a second way to spend money.
 *
 * @returns {Promise<{ amountIn: bigint, amountInAfterFee: bigint, feeBps: number,
 *   reserveIn: bigint, reserveOut: bigint }>}
 */
async function quoteExactOut({ provider, amountOut, tokenIn, tokenOut, chainKey }) {
  const want = BigInt(amountOut);
  const { reserveIn, reserveOut } = await getPairReserves(provider, {
    tokenIn,
    tokenOut,
    chainKey,
  });

  const amountInAfterFee = amountInForExactOut(want, reserveIn, reserveOut);
  const feeBps = await readFeeBps(provider, chainKey);
  const amountIn = grossUpForFee(amountInAfterFee, feeBps);

  return { amountIn, amountInAfterFee, feeBps, reserveIn, reserveOut };
}

/**
 * Find the pool for a pair, or null when there is none.
 *
 * Takes both sides rather than assuming WETH: routing here is a single hop, so
 * the pool that matters is the one holding exactly these two tokens. Asking for
 * a token's WETH pool while quoting a token-to-token swap would find a real
 * pool that is the wrong one, and lean on a later check to reject it.
 *
 * The configured pair short-circuits, so the FLZ path costs no extra call and
 * keeps working if the factory is ever misconfigured. Everything else goes to
 * the factory, which is what makes a pasted contract quotable at all.
 *
 * @returns {Promise<string|null>} pair address, or null if no pool exists
 */
async function findPair(provider, tokenA, tokenB, chainKey) {
  const d = getDexConfig(chainKey);
  const a = ethers.getAddress(tokenA);
  const b = ethers.getAddress(tokenB);
  if (a === b) return null;

  if (d.pair && d.flz && d.wrappedNative) {
    const both = new Set([a, b]);
    if (both.has(d.flz) && both.has(d.wrappedNative)) return d.pair;
  }
  if (!d.factory) return null;

  const factory = new ethers.Contract(d.factory, FACTORY_ABI, provider);
  const pair = await factory.getPair(a, b);
  const addr = ethers.getAddress(pair);
  return addr === ethers.ZeroAddress ? null : addr;
}

/** The WETH pool for a token, which is what a pasted contract is bought from. */
async function findWethPair(provider, tokenAddress, chainKey) {
  const d = getDexConfig(chainKey);
  if (!d.wrappedNative) return null;
  return findPair(provider, tokenAddress, d.wrappedNative, chainKey);
}

/**
 * Everything a payer needs to decide about a pasted contract, in one read.
 *
 * Only facts that come cheaply off an RPC. Deliberately NOT here:
 *   - holder concentration, which needs an indexer replaying Transfer logs;
 *   - pool age, which needs an unbounded PairCreated log scan many RPCs cap.
 * Promising either and quietly returning nothing would be worse than the
 * caller knowing they are absent.
 *
 * `pool` is the load-bearing field. A token with no pool cannot be bought at
 * all, and saying so is more useful than any number on this screen -- market
 * cap in particular is trivially faked by whoever deployed the token.
 *
 * @returns {Promise<{
 *   address: string, symbol: string, decimals: number, totalSupply: bigint,
 *   pool: string|null, liquidityEthWei: bigint|null, priceEthPerToken: number|null,
 *   marketCapEth: number|null, isListed: boolean,
 * }>}
 */
async function getTokenOverview(provider, tokenAddress, chainKey) {
  const d = getDexConfig(chainKey);
  const address = ethers.getAddress(tokenAddress);
  const token = new ethers.Contract(address, ERC20_META_ABI, provider);

  const [decimalsRaw, symbolRaw, totalSupply] = await Promise.all([
    token.decimals(),
    token.symbol(),
    token.totalSupply(),
  ]);
  const decimals = Number(decimalsRaw);
  const symbol = String(symbolRaw);
  const isListed = Boolean(d.flz) && address === d.flz;

  const pool = await findWethPair(provider, address, chainKey);
  if (!pool) {
    return {
      address,
      symbol,
      decimals,
      totalSupply,
      pool: null,
      liquidityEthWei: null,
      priceEthPerToken: null,
      marketCapEth: null,
      isListed,
    };
  }

  const pair = new ethers.Contract(pool, PAIR_ABI, provider);
  const [reserves, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
  const token0 = ethers.getAddress(t0);
  const [r0, r1] = reserves;
  const reserveToken = token0 === address ? r0 : r1;
  const reserveEth = token0 === address ? r1 : r0;

  // Spot price straight off reserves. Float is fine here: this number is only
  // ever displayed. Every amount that moves money is quoted in wei elsewhere.
  const tokenFloat = Number(ethers.formatUnits(reserveToken, decimals));
  const ethFloat = Number(ethers.formatEther(reserveEth));
  const priceEthPerToken = tokenFloat > 0 ? ethFloat / tokenFloat : null;
  const supplyFloat = Number(ethers.formatUnits(totalSupply, decimals));
  const marketCapEth =
    priceEthPerToken != null && Number.isFinite(supplyFloat)
      ? priceEthPerToken * supplyFloat
      : null;

  return {
    address,
    symbol,
    decimals,
    totalSupply,
    pool,
    liquidityEthWei: reserveEth,
    priceEthPerToken,
    marketCapEth,
    isListed,
  };
}

async function getTokenMeta(provider, tokenAddress) {
  if (!tokenAddress) return { decimals: 18, symbol: 'ETH' };
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
  return { decimals: Number(decimals), symbol: String(symbol) };
}

/**
 * Spot price: FLZ per 1 ETH from pair reserves.
 */
async function getFlzPrice(provider, chainKey) {
  const d = getDexConfig(chainKey);
  if (!d.pair || !d.flz || !d.wrappedNative) {
    throw new Error('Pair not configured');
  }
  // FLZ in, native out: reserveIn is the FLZ side, reserveOut the WETH side.
  const { reserveIn: reserveFlz, reserveOut: reserveWeth } = await getPairReserves(provider, {
    tokenIn: d.flz,
    tokenOut: null,
    chainKey,
  });
  if (reserveWeth === 0n || reserveFlz === 0n) throw new Error('Empty pool');
  // FLZ per 1 ETH
  const flzPerEth = (reserveFlz * ethers.parseEther('1')) / reserveWeth;
  const ethPerFlz = (reserveWeth * ethers.parseEther('1')) / reserveFlz;
  return {
    flzPerEth: ethers.formatEther(flzPerEth),
    ethPerFlz: ethers.formatEther(ethPerFlz),
    reserveFlz: ethers.formatEther(reserveFlz),
    reserveWeth: ethers.formatEther(reserveWeth),
    pair: d.pair,
    flz: d.flz,
  };
}

/**
 * Ensure ERC20 allowance for spender.
 */
async function ensureAllowance(token, ownerSigner, spender, amount) {
  const current = await token.allowance(await ownerSigner.getAddress(), spender);
  if (current >= amount) return null;
  const tx = await token.approve(spender, ethers.MaxUint256);
  await tx.wait(1);
  return tx.hash;
}

/**
 * Execute swap from a signer (agent wallet).
 */
async function executeSwap({
  signer,
  amountIn,
  tokenIn,
  tokenOut,
  amountOutMinWei,
  chainKey,
  recipient,
}) {
  const d = getDexConfig(chainKey);
  if (!d.feeRouter) throw new Error('Fee router not configured');
  const to = recipient || (await signer.getAddress());
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const feeRouter = new ethers.Contract(d.feeRouter, FEE_ROUTER_ABI, signer);

  const inIsNative = tokenIn === null || tokenIn === undefined;
  const outIsNative = tokenOut === null || tokenOut === undefined;
  const path = [];
  if (inIsNative) path.push(d.wrappedNative);
  else path.push(ethers.getAddress(tokenIn));
  if (outIsNative) path.push(d.wrappedNative);
  else path.push(ethers.getAddress(tokenOut));

  let tx;
  if (inIsNative) {
    tx = await feeRouter.swapExactETHForTokens(amountOutMinWei, path, to, deadline, {
      value: amountIn,
    });
  } else if (outIsNative) {
    const token = new ethers.Contract(tokenIn, ERC20_ABI, signer);
    await ensureAllowance(token, signer, d.feeRouter, amountIn);
    tx = await feeRouter.swapExactTokensForETH(amountIn, amountOutMinWei, path, to, deadline);
  } else {
    const token = new ethers.Contract(tokenIn, ERC20_ABI, signer);
    await ensureAllowance(token, signer, d.feeRouter, amountIn);
    tx = await feeRouter.swapExactTokensForTokens(amountIn, amountOutMinWei, path, to, deadline);
  }
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error('Swap transaction failed on-chain');
  }
  return { txHash: tx.hash, receipt };
}

/**
 * Swap whose msg.sender must be the HybridDeleGator (UserOp execute).
 */
async function executeSwapViaGator({
  accountId,
  provider,
  chainId,
  amountIn,
  tokenIn,
  tokenOut,
  amountOutMinWei,
  chainKey,
  recipient,
}) {
  const { executeGatorCall } = require('./gatorExecute');
  const d = getDexConfig(chainKey);
  if (!d.feeRouter) throw new Error('Fee router not configured');
  const to = ethers.getAddress(recipient);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const feeRouter = new ethers.Interface(FEE_ROUTER_ABI);
  const inIsNative = tokenIn === null || tokenIn === undefined;
  const outIsNative = tokenOut === null || tokenOut === undefined;
  const path = [];
  if (inIsNative) path.push(d.wrappedNative);
  else path.push(ethers.getAddress(tokenIn));
  if (outIsNative) path.push(d.wrappedNative);
  else path.push(ethers.getAddress(tokenOut));

  if (!inIsNative) {
    const token = new ethers.Interface(ERC20_ABI);
    const approveData = token.encodeFunctionData('approve', [d.feeRouter, amountIn]);
    await executeGatorCall({
      accountId,
      provider,
      chainId,
      target: tokenIn,
      value: 0n,
      data: approveData,
    });
  }

  let data;
  let value = 0n;
  if (inIsNative) {
    data = feeRouter.encodeFunctionData('swapExactETHForTokens', [
      amountOutMinWei,
      path,
      to,
      deadline,
    ]);
    value = amountIn;
  } else if (outIsNative) {
    data = feeRouter.encodeFunctionData('swapExactTokensForETH', [
      amountIn,
      amountOutMinWei,
      path,
      to,
      deadline,
    ]);
  } else {
    data = feeRouter.encodeFunctionData('swapExactTokensForTokens', [
      amountIn,
      amountOutMinWei,
      path,
      to,
      deadline,
    ]);
  }
  return executeGatorCall({
    accountId,
    provider,
    chainId,
    target: d.feeRouter,
    value,
    data,
  });
}

/**
 * Add liquidity ETH + token via fee router (site only).
 */
async function addLiquidityEth({
  signer,
  tokenAddress,
  amountToken,
  amountEth,
  amountTokenMin,
  amountEthMin,
  chainKey,
  recipient,
}) {
  const d = getDexConfig(chainKey);
  if (!d.feeRouter) throw new Error('Fee router not configured');
  const to = recipient || (await signer.getAddress());
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  await ensureAllowance(token, signer, d.feeRouter, amountToken);
  const feeRouter = new ethers.Contract(d.feeRouter, FEE_ROUTER_ABI, signer);
  const tx = await feeRouter.addLiquidityETH(
    tokenAddress,
    amountToken,
    amountTokenMin ?? 0n,
    amountEthMin ?? 0n,
    to,
    deadline,
    { value: amountEth }
  );
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Add liquidity failed');
  return { txHash: tx.hash, receipt };
}

module.exports = {
  findPair,
  findWethPair,
  getTokenOverview,
  FEE_ROUTER_ABI,
  V2_ROUTER_ABI,
  ERC20_ABI,
  PAIR_ABI,
  loadDeployments,
  getDexConfig,
  getRouterAllowlist,
  isAllowedSwapRouter,
  resolveToken,
  tokenLabel,
  listedSendSymbols,
  isUnverifiedSwap,
  SOCIAL_SEND_REFUSAL,
  resolveListedSendAsset,
  computeFee,
  amountOutMin,
  amountInForExactOut,
  grossUpForFee,
  readFeeBps,
  quoteSwap,
  getPairReserves,
  quoteExactOut,
  getTokenMeta,
  getFlzPrice,
  ensureAllowance,
  executeSwap,
  executeSwapViaGator,
  addLiquidityEth,
};
