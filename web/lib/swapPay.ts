import { ethers } from 'ethers';
import { liquidityPool, readFeeBps } from './dexServer';

/**
 * Pay in a token you do not hold, with ETH: one swap whose output goes
 * straight to the payee.
 *
 * The payer asks for an exact amount of the token to arrive. The ETH to send
 * is solved from the pool's reserves (constant product, 0.3% pool fee), grossed
 * up for the fee router's cut, then padded by PAY_SWAP_BUFFER_BPS so a small
 * price move between quote and block does not fail the payment. The swap is
 * sent exact-in with that ETH and with amountOutMin set to the full amount
 * asked, so the payee always receives at least what was asked; any surplus
 * from the padding lands with the payee, never back with nobody.
 */

/** Padding on the ETH sent, in basis points: 0.5%. The most the payer can overpay by. */
export const PAY_SWAP_BUFFER_BPS = 50;

/** The pools this can pay through: FLZ and tUSD, each against WETH. */
export type SwapPayAsset = 'FLZ' | 'TUSD';

const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
];

/** Pool input that buys exactly `amountOut`, before any router fee. Same math as lib/dex.js amountInForExactOut. */
export function amountInForExactOut(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n) throw new Error('Amount must be greater than zero');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Empty pool');
  if (amountOut >= reserveOut) throw new Error('The pool does not hold that much. Try a smaller amount.');
  return (reserveIn * amountOut * 1000n) / ((reserveOut - amountOut) * 997n) + 1n;
}

/** The input to send so `amountAfterFee` survives the router's cut. Same as lib/dex.js grossUpForFee. */
export function grossUpForFee(amountAfterFee: bigint, feeBps: number): bigint {
  const net = 10000n - BigInt(feeBps);
  if (net <= 0n) throw new Error('Swap fee misconfigured');
  return (amountAfterFee * 10000n + net - 1n) / net;
}

export type SwapPayQuote = {
  asset: SwapPayAsset;
  token: string;
  decimals: number;
  /** Exactly what the payee is guaranteed, in the token's smallest unit. */
  amountOut: bigint;
  /** What the payer sends, padding included. */
  ethIn: bigint;
  feeBps: number;
};

/** Quote paying `amount` of `asset` with ETH. Throws when the pool cannot fill it. */
export async function quoteSwapPay(provider: ethers.Provider, asset: SwapPayAsset, amount: string): Promise<SwapPayQuote> {
  const pool = liquidityPool(asset);
  if (!pool) throw new Error(`No ETH pool for ${asset}.`);
  const amountOut = ethers.parseUnits(amount, pool.decimals);
  const pair = new ethers.Contract(pool.pair, PAIR_ABI, provider);
  const [[r0, r1], token0] = (await Promise.all([pair.getReserves(), pair.token0()])) as [[bigint, bigint], string];
  const tokenIsToken0 = token0.toLowerCase() === pool.token.toLowerCase();
  const reserveOut = tokenIsToken0 ? r0 : r1;
  const reserveIn = tokenIsToken0 ? r1 : r0;
  const feeBps = await readFeeBps(provider);
  const exact = grossUpForFee(amountInForExactOut(amountOut, reserveIn, reserveOut), feeBps);
  const ethIn = (exact * BigInt(10000 + PAY_SWAP_BUFFER_BPS) + 9999n) / 10000n;
  return { asset, token: pool.token, decimals: pool.decimals, amountOut, ethIn, feeBps };
}

/**
 * What a payer is told when the pool cannot price a payment. Fixed copy, never
 * the error itself: a provider error can carry the RPC URL.
 */
export function quoteRefusal(err: unknown): string {
  const text = err instanceof Error ? err.message : '';
  if (/does not hold that much/.test(text)) return 'The pool cannot fill that much. Try a smaller amount.';
  if (/greater than zero|invalid|parse/i.test(text)) return 'Enter an amount above 0.';
  return 'Could not price this in ETH right now. Try again shortly.';
}

/**
 * What actually reached the payee in a confirmed swap: the sum of the token's
 * Transfer events to them in that receipt. Read rather than assumed, so the
 * record and the receipt say what landed, padding surplus included.
 */
export function receivedInReceipt(
  receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> },
  token: string,
  payee: string
): bigint {
  const transfer = ethers.id('Transfer(address,address,uint256)');
  const to = ethers.zeroPadValue(ethers.getAddress(payee), 32).toLowerCase();
  let total = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    if (log.topics[0] !== transfer || String(log.topics[2] || '').toLowerCase() !== to) continue;
    total += BigInt(log.data);
  }
  return total;
}
