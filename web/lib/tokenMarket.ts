/**
 * Trade prints and candles for a listed pool.
 *
 * A print is one swap: ETH paid or received, divided by FLZ moved. It is a
 * trade price, not a dollar mark and not a fabricated candle. One print is a
 * price. A change needs two.
 */

import { ethers } from 'ethers';

export type Print = {
  time: number;
  priceEth: number;
  volumeEth: number;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeEth: number;
};

export type ChartRange = 'live' | '1h' | '4h' | 'all';

const CHART_RANGES: ChartRange[] = ['live', '1h', '4h', 'all'];

export function isChartRange(value: string): value is ChartRange {
  return (CHART_RANGES as string[]).includes(value);
}

export function printFromSwap(args: {
  flzIsToken0: boolean;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  time: number;
}): Print | null {
  const flzIn = args.flzIsToken0 ? args.amount0In : args.amount1In;
  const flzOut = args.flzIsToken0 ? args.amount0Out : args.amount1Out;
  const ethIn = args.flzIsToken0 ? args.amount1In : args.amount0In;
  const ethOut = args.flzIsToken0 ? args.amount1Out : args.amount0Out;
  const flz = flzIn > 0n ? flzIn : flzOut;
  const eth = ethIn > 0n ? ethIn : ethOut;
  if (flz <= 0n || eth <= 0n) return null;
  if (!Number.isFinite(args.time)) return null;
  const priceEth = Number(ethers.formatEther(eth)) / Number(ethers.formatEther(flz));
  const volumeEth = Number(ethers.formatEther(eth));
  if (!Number.isFinite(priceEth) || priceEth <= 0) return null;
  if (!Number.isFinite(volumeEth) || volumeEth < 0) return null;
  return { time: args.time, priceEth, volumeEth };
}

export function buildCandles(prints: Print[], bucketSec: number): Candle[] {
  if (!Number.isInteger(bucketSec) || bucketSec < 1) {
    throw new Error('bucket');
  }
  const sorted = prints
    .filter((print) => Number.isFinite(print.time) && Number.isFinite(print.priceEth) && print.priceEth > 0)
    .slice()
    .sort((a, b) => a.time - b.time);
  const buckets = new Map<number, Candle>();
  for (const print of sorted) {
    const time = Math.floor(print.time / bucketSec) * bucketSec;
    const volume = Number.isFinite(print.volumeEth) && print.volumeEth > 0 ? print.volumeEth : 0;
    const existing = buckets.get(time);
    if (!existing) {
      buckets.set(time, {
        time,
        open: print.priceEth,
        high: print.priceEth,
        low: print.priceEth,
        close: print.priceEth,
        volumeEth: volume,
      });
      continue;
    }
    existing.high = Math.max(existing.high, print.priceEth);
    existing.low = Math.min(existing.low, print.priceEth);
    existing.close = print.priceEth;
    existing.volumeEth += volume;
  }
  return [...buckets.values()];
}

/** Percent move from the first print to the last. One print is not a move. */
export function changePct(prints: Print[]): number | null {
  const sorted = prints
    .filter((print) => Number.isFinite(print.priceEth) && print.priceEth > 0 && Number.isFinite(print.time))
    .slice()
    .sort((a, b) => a.time - b.time);
  if (sorted.length < 2) return null;
  const open = sorted[0].priceEth;
  const close = sorted[sorted.length - 1].priceEth;
  if (!(open > 0) || !Number.isFinite(close)) return null;
  return ((close - open) / open) * 100;
}

export function bucketForRange(range: ChartRange): number {
  if (range === 'live') return 60;
  if (range === '1h') return 300;
  if (range === '4h') return 900;
  return 3600;
}

/** Seconds of history the range displays. Null means the whole fetched window. */
export function rangeSeconds(range: ChartRange): number | null {
  if (range === 'live') return 15 * 60;
  if (range === '1h') return 60 * 60;
  if (range === '4h') return 4 * 60 * 60;
  return null;
}

export function sumVolume(prints: Print[]): number {
  return prints.reduce((total, print) => {
    if (!Number.isFinite(print.volumeEth) || print.volumeEth <= 0) return total;
    return total + print.volumeEth;
  }, 0);
}
