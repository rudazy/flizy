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
  const pair = new ethers.Contract(d.pair, PAIR_ABI, provider);
  const [r0, r1] = await pair.getReserves();
  const t0 = await pair.token0();
  const flzIs0 = ethers.getAddress(t0) === d.flz;
  const reserveFlz = flzIs0 ? r0 : r1;
  const reserveWeth = flzIs0 ? r1 : r0;
  if (reserveWeth === 0n) throw new Error('Empty pool');
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
  computeFee,
  amountOutMin,
  readFeeBps,
  quoteSwap,
  getTokenMeta,
  getFlzPrice,
  ensureAllowance,
  executeSwap,
  addLiquidityEth,
};
