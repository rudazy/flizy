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
  /** buy when FLZ left the pool. Absent on prints built before sides were read. */
  side?: 'buy' | 'sell';
  flzAmount?: number;
};

export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeEth: number;
};

/**
 * The ranges the chart offers. All three are cut from one 24-hour read of the
 * pool. Longer ranges would need trades stored by Flizy: GIWA answers at most
 * about 10,000 blocks (under three hours) per log request.
 */
export type ChartRange = '1h' | '4h' | '1d';

export const CHART_RANGES: ChartRange[] = ['1h', '4h', '1d'];

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
  // FLZ leaving the pool is somebody buying it.
  const side = flzOut > 0n && flzIn === 0n ? 'buy' : 'sell';
  return { time: args.time, priceEth, volumeEth, side, flzAmount: Number(ethers.formatEther(flz)) };
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

/** Seconds per candle: about 30 to 50 points whatever the range. */
export function bucketForRange(range: ChartRange): number {
  if (range === '1h') return 120;
  if (range === '4h') return 600;
  return 1800;
}

/** Seconds of history the range displays. */
export function rangeSeconds(range: ChartRange): number {
  if (range === '1h') return 60 * 60;
  if (range === '4h') return 4 * 60 * 60;
  return 24 * 60 * 60;
}

export function sumVolume(prints: Print[]): number {
  return prints.reduce((total, print) => {
    if (!Number.isFinite(print.volumeEth) || print.volumeEth <= 0) return total;
    return total + print.volumeEth;
  }, 0);
}

/**
 * Inclusive block ranges of at most `size` blocks covering [from, to], in
 * order, with no gap and no overlap. GIWA refuses a log request much over
 * 10,000 blocks, so a day is read as several.
 */
export function blockChunks(from: number, to: number, size: number): Array<[number, number]> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(size) || size < 1) {
    throw new Error('chunks');
  }
  const out: Array<[number, number]> = [];
  for (let start = Math.max(0, from); start <= to; start += size) {
    out.push([start, Math.min(to, start + size - 1)]);
  }
  return out;
}

export type DayStats = {
  high: number | null;
  low: number | null;
  volumeEth: number;
  trades: number;
  buys: number;
  sells: number;
  changePct: number | null;
};

/** The 24-hour figures from a day of prints. Nothing is invented for a quiet day. */
export function dayStats(prints: Print[]): DayStats {
  const valid = prints.filter((p) => Number.isFinite(p.priceEth) && p.priceEth > 0);
  return {
    high: valid.length ? Math.max(...valid.map((p) => p.priceEth)) : null,
    low: valid.length ? Math.min(...valid.map((p) => p.priceEth)) : null,
    volumeEth: sumVolume(valid),
    trades: valid.length,
    buys: valid.filter((p) => p.side === 'buy').length,
    sells: valid.filter((p) => p.side === 'sell').length,
    changePct: changePct(valid),
  };
}

/**
 * Who traded, from the FLZ transfers in the swap's transaction.
 *
 * Not tx.from: a Flizy wallet's trade is submitted by the ops key, so the
 * sender would name Flizy, not the trader. The trader is the end of the FLZ
 * movement that is not pool or router plumbing: where FLZ went on a buy,
 * where it came from on a sell.
 */
export function traderFromTransfers(
  transfers: Array<{ from: string; to: string }>,
  side: 'buy' | 'sell',
  plumbing: string[]
): string | null {
  const infra = new Set(plumbing.map((a) => a.toLowerCase()));
  for (const t of transfers) {
    const end = side === 'buy' ? t.to : t.from;
    if (end && !infra.has(end.toLowerCase()) && end !== ethers.ZeroAddress) return ethers.getAddress(end);
  }
  return null;
}
