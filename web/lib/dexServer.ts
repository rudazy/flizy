/**
 * Site-side DEX helpers (self-contained for Vercel / web package).
 * Addresses mirror deployments/giwa-sepolia.json; env can override.
 * Does not import monorepo root lib/ (webpack cannot resolve root deps on Vercel).
 */

import { ethers } from 'ethers';

const FEE_ROUTER_ABI = [
  'function feeBps() view returns (uint16)',
  'function quoteFee(uint256 amountIn) view returns (uint256 feeAmount, uint256 amountAfterFee)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const V2_ROUTER_ABI = [
  'function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) returns (uint amountToken, uint amountETH)',
];

export type WebChain = {
  id: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerBaseUrl: string;
  nativeSymbol: string;
};

export function getWebChain(): WebChain {
  return {
    id: 'giwa_sepolia',
    name: 'GIWA Sepolia',
    chainId: Number(process.env.GIWA_CHAIN_ID || 91342),
    rpcUrl: process.env.GIWA_RPC || process.env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io',
    explorerBaseUrl: (
      process.env.GIWA_EXPLORER ||
      process.env.CHAIN_GIWA_SEPOLIA_EXPLORER ||
      'https://sepolia-explorer.giwa.io'
    ).replace(/\/$/, ''),
    nativeSymbol: 'ETH',
  };
}

export function getDexAddresses() {
  return {
    wrappedNative: ethers.getAddress(
      process.env.CHAIN_GIWA_SEPOLIA_WETH || '0x3a13399f2741122B63c7710B2A85346B97C6BFDf'
    ),
    dexRouter: ethers.getAddress(
      process.env.CHAIN_GIWA_SEPOLIA_DEX_ROUTER || '0x4055413A4757e069bbCAc481639EF2814224Faa0'
    ),
    feeRouter: ethers.getAddress(
      process.env.CHAIN_GIWA_SEPOLIA_FEE_ROUTER || '0x6427fD0c13577847888B7E2d1A24C887bBEBd9cC'
    ),
    flz: ethers.getAddress(
      process.env.CHAIN_GIWA_SEPOLIA_FLZ || '0x308be8f71DA695f18E70D2243a446e1fD1566BA6'
    ),
    pair: ethers.getAddress(
      process.env.CHAIN_GIWA_SEPOLIA_FLZ_WETH_PAIR || '0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227'
    ),
    feeBpsDefault: Number(process.env.SWAP_FEE_BPS || 30),
    slippageBpsDefault: Number(process.env.SWAP_SLIPPAGE_BPS || 100),
  };
}

export function isAllowedSwapRouter(address: string): boolean {
  if (!address || !ethers.isAddress(address)) return false;
  const d = getDexAddresses();
  const a = ethers.getAddress(address).toLowerCase();
  return a === d.feeRouter.toLowerCase() || a === d.dexRouter.toLowerCase();
}

/** null = native ETH */
export function resolveToken(symbolOrAddress: string): string | null {
  const raw = String(symbolOrAddress || '').trim();
  if (!raw) throw new Error('Token required');
  // ethers.isAddress can narrow poorly under strict TS; check then cast.
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    return ethers.getAddress(raw);
  }
  const s = raw.toUpperCase();
  if (s === 'ETH' || s === 'NATIVE') return null;
  if (s === 'WETH') return getDexAddresses().wrappedNative;
  if (s === 'FLZ' || s === 'FLIZY') return getDexAddresses().flz;
  throw new Error(`Unknown token: ${raw}. Use ETH, FLZ, or a 0x address.`);
}

export function tokenLabel(symbolOrAddress: string | null): string {
  if (symbolOrAddress === null || symbolOrAddress === undefined) return 'ETH';
  const raw = String(symbolOrAddress).trim();
  if (!raw || /^eth$/i.test(raw) || /^native$/i.test(raw)) return 'ETH';
  if (/^flz$/i.test(raw) || /^flizy$/i.test(raw)) return 'FLZ';
  if (/^weth$/i.test(raw)) return 'WETH';
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    const d = getDexAddresses();
    const addr = ethers.getAddress(raw);
    if (addr === d.flz) return 'FLZ';
    if (addr === d.wrappedNative) return 'WETH';
    return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
  }
  return String(raw).toUpperCase();
}

function computeFee(amountIn: bigint, feeBps: number) {
  const feeAmount = (amountIn * BigInt(feeBps)) / 10000n;
  return { feeAmount, amountAfterFee: amountIn - feeAmount };
}

function amountOutMin(amountOut: bigint, slippageBps: number) {
  return amountOut - (amountOut * BigInt(slippageBps)) / 10000n;
}

export function explorerTxUrl(chain: WebChain, txHash: string) {
  return `${chain.explorerBaseUrl}/tx/${txHash}`;
}

export function deriveAgentWallet(accountId: string) {
  const material = ethers.keccak256(ethers.toUtf8Bytes(`flizy:agent:v1:${accountId}`));
  return new ethers.Wallet(material);
}

export async function readFeeBps(provider: ethers.Provider): Promise<number> {
  const d = getDexAddresses();
  try {
    const c = new ethers.Contract(d.feeRouter, FEE_ROUTER_ABI, provider);
    return Number(await c.feeBps());
  } catch {
    return d.feeBpsDefault;
  }
}

export async function getFlzPrice(provider: ethers.Provider) {
  const d = getDexAddresses();
  const pair = new ethers.Contract(d.pair, PAIR_ABI, provider);
  const [r0, r1] = await pair.getReserves();
  const t0 = await pair.token0();
  const flzIs0 = ethers.getAddress(t0) === d.flz;
  const reserveFlz = flzIs0 ? r0 : r1;
  const reserveWeth = flzIs0 ? r1 : r0;
  if (reserveWeth === 0n) throw new Error('Empty pool');
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

export async function quoteSwap(args: {
  provider: ethers.Provider;
  amountIn: bigint;
  tokenIn: string | null;
  tokenOut: string | null;
  slippageBps?: number;
}) {
  const d = getDexAddresses();
  const feeBps = await readFeeBps(args.provider);
  const slip = args.slippageBps ?? d.slippageBpsDefault;
  const inIsNative = args.tokenIn === null;
  const outIsNative = args.tokenOut === null;
  const path: string[] = [];
  path.push(inIsNative ? d.wrappedNative : ethers.getAddress(args.tokenIn!));
  path.push(outIsNative ? d.wrappedNative : ethers.getAddress(args.tokenOut!));
  if (path[0].toLowerCase() === path[1].toLowerCase()) {
    throw new Error('Cannot swap a token for itself');
  }
  const feeRouter = new ethers.Contract(d.feeRouter, FEE_ROUTER_ABI, args.provider);
  const amounts: bigint[] = await feeRouter.getAmountsOut(args.amountIn, path);
  const amountOut = amounts[amounts.length - 1];
  const { feeAmount, amountAfterFee } = computeFee(args.amountIn, feeBps);
  return {
    path,
    amounts,
    amountIn: args.amountIn,
    amountOut,
    amountOutMin: amountOutMin(amountOut, slip),
    feeAmount,
    amountAfterFee,
    feeBps,
    slippageBps: slip,
    inIsNative,
    outIsNative,
    feeRouter: d.feeRouter,
  };
}

async function ensureAllowance(
  token: ethers.Contract,
  owner: ethers.Signer,
  spender: string,
  amount: bigint
) {
  const ownerAddr = await owner.getAddress();
  const current: bigint = await token.allowance(ownerAddr, spender);
  if (current >= amount) return;
  const tx = await token.approve(spender, ethers.MaxUint256);
  await tx.wait(1);
}

export async function executeSwap(args: {
  signer: ethers.Wallet;
  amountIn: bigint;
  tokenIn: string | null;
  tokenOut: string | null;
  amountOutMinWei: bigint;
  recipient?: string;
}) {
  const d = getDexAddresses();
  const to = args.recipient || (await args.signer.getAddress());
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const feeRouter = new ethers.Contract(d.feeRouter, FEE_ROUTER_ABI, args.signer);
  const inIsNative = args.tokenIn === null;
  const outIsNative = args.tokenOut === null;
  const path: string[] = [];
  path.push(inIsNative ? d.wrappedNative : ethers.getAddress(args.tokenIn!));
  path.push(outIsNative ? d.wrappedNative : ethers.getAddress(args.tokenOut!));

  let tx: ethers.ContractTransactionResponse;
  if (inIsNative) {
    tx = await feeRouter.swapExactETHForTokens(args.amountOutMinWei, path, to, deadline, {
      value: args.amountIn,
    });
  } else if (outIsNative) {
    const token = new ethers.Contract(args.tokenIn!, ERC20_ABI, args.signer);
    await ensureAllowance(token, args.signer, d.feeRouter, args.amountIn);
    tx = await feeRouter.swapExactTokensForETH(args.amountIn, args.amountOutMinWei, path, to, deadline);
  } else {
    const token = new ethers.Contract(args.tokenIn!, ERC20_ABI, args.signer);
    await ensureAllowance(token, args.signer, d.feeRouter, args.amountIn);
    throw new Error('Token-to-token swaps are not exposed on the site yet. Use buy or sell.');
  }
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Swap transaction failed on-chain');
  return { txHash: tx.hash, receipt };
}

export async function addLiquidityEth(args: {
  signer: ethers.Wallet;
  tokenAddress: string;
  amountToken: bigint;
  amountEth: bigint;
  amountTokenMin: bigint;
  amountEthMin: bigint;
  recipient?: string;
}) {
  const d = getDexAddresses();
  const to = args.recipient || (await args.signer.getAddress());
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const token = new ethers.Contract(args.tokenAddress, ERC20_ABI, args.signer);
  await ensureAllowance(token, args.signer, d.feeRouter, args.amountToken);
  const feeRouter = new ethers.Contract(d.feeRouter, FEE_ROUTER_ABI, args.signer);
  const tx = await feeRouter.addLiquidityETH(
    args.tokenAddress,
    args.amountToken,
    args.amountTokenMin,
    args.amountEthMin,
    to,
    deadline,
    { value: args.amountEth }
  );
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Add liquidity failed');
  return { txHash: tx.hash, receipt };
}

/**
 * Read LP position for an agent wallet (pair balance + underlying ETH/FLZ share).
 */
export async function getLpPosition(provider: ethers.Provider, ownerAddress: string) {
  const d = getDexAddresses();
  const pair = new ethers.Contract(d.pair, PAIR_ABI, provider);
  const [lpBal, totalSupply, reserves, t0] = await Promise.all([
    pair.balanceOf(ownerAddress) as Promise<bigint>,
    pair.totalSupply() as Promise<bigint>,
    pair.getReserves() as Promise<[bigint, bigint, number]>,
    pair.token0() as Promise<string>,
  ]);

  const reserve0 = reserves[0];
  const reserve1 = reserves[1];
  const flzIs0 = ethers.getAddress(String(t0)) === d.flz;
  const reserveFlz = flzIs0 ? reserve0 : reserve1;
  const reserveWeth = flzIs0 ? reserve1 : reserve0;

  let ethShare = 0n;
  let flzShare = 0n;
  if (totalSupply > 0n && lpBal > 0n) {
    ethShare = (reserveWeth * lpBal) / totalSupply;
    flzShare = (reserveFlz * lpBal) / totalSupply;
  }

  return {
    pair: d.pair,
    lpBalance: lpBal,
    lpBalanceFormatted: ethers.formatEther(lpBal),
    totalSupply: totalSupply.toString(),
    ethShare: ethers.formatEther(ethShare),
    flzShare: ethers.formatEther(flzShare),
    ethShareWei: ethShare,
    flzShareWei: flzShare,
    poolShareBps: totalSupply > 0n ? Number((lpBal * 10000n) / totalSupply) : 0,
  };
}

/**
 * Remove LP for FLZ/WETH via the V2 router (allowlisted). No protocol fee on remove.
 * @param liquidityWei amount of LP tokens to burn; omit or use max for full position
 */
export async function removeLiquidityEth(args: {
  signer: ethers.Wallet;
  liquidityWei: bigint;
  amountTokenMin?: bigint;
  amountEthMin?: bigint;
  recipient?: string;
}) {
  const d = getDexAddresses();
  if (args.liquidityWei <= 0n) throw new Error('Liquidity amount must be greater than 0');

  const to = args.recipient || (await args.signer.getAddress());
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const pair = new ethers.Contract(d.pair, PAIR_ABI, args.signer);
  const bal: bigint = await pair.balanceOf(await args.signer.getAddress());
  if (bal < args.liquidityWei) {
    throw new Error('Not enough LP tokens in your agent wallet');
  }

  await ensureAllowance(pair, args.signer, d.dexRouter, args.liquidityWei);

  const router = new ethers.Contract(d.dexRouter, V2_ROUTER_ABI, args.signer);
  const tx = await router.removeLiquidityETH(
    d.flz,
    args.liquidityWei,
    args.amountTokenMin ?? 0n,
    args.amountEthMin ?? 0n,
    to,
    deadline
  );
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) throw new Error('Remove liquidity failed');
  return { txHash: tx.hash, receipt };
}

/**
 * Minimal site policy for swaps: linked + allowlisted router.
 * Does not apply trusted contacts or daily send limit.
 */
export function assertSwapAllowed(accountId: string | null, router: string) {
  if (!accountId) {
    return { ok: false as const, message: 'Not logged in' };
  }
  if (!isAllowedSwapRouter(router)) {
    return { ok: false as const, message: 'That swap router is not allowed.' };
  }
  return { ok: true as const };
}
