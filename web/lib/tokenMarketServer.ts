/**
 * Spot price and swap prints for the one token Flizy lists.
 *
 * FLZ against ETH on the Flizy pool. No other symbol is accepted by the
 * route that calls this, so the handler cannot be aimed at an arbitrary
 * contract. Dollar marks are not computed here.
 *
 * One read covers the last 24 hours, and every range the page offers is cut
 * from it: the chart, the 24-hour figures and the recent trades all describe
 * the same trades. GIWA answers at most about 10,000 blocks per log request
 * (1-second blocks), so the day is read in chunks.
 */

import { ethers } from 'ethers';
import { getDexAddresses, getWebChain } from './dexServer';
import {
  blockChunks,
  buildCandles,
  bucketForRange,
  changePct,
  dayStats,
  printFromSwap,
  rangeSeconds,
  traderFromTransfers,
  type Candle,
  type ChartRange,
  type DayStats,
  type Print,
} from './tokenMarket';

const SWAP_ABI = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const iface = new ethers.Interface(SWAP_ABI);
const erc20 = new ethers.Interface(ERC20_ABI);

/** Under GIWA's refusal point (about 10,000 blocks), with room to spare. */
const LOG_CHUNK = 9_000;
/** Log requests in flight at once. */
const CHUNK_PARALLEL = 3;
const DAY_SECONDS = 24 * 60 * 60;
/** Trades in the Recent activity table; each costs one receipt read. */
const ACTIVITY_ROWS = 20;

export type ActivityRow = {
  time: number;
  side: 'buy' | 'sell';
  ethAmount: number;
  flzAmount: number;
  /** The trading wallet, or null when the receipt does not show one. */
  trader: string | null;
  txHash: string;
  txUrl: string;
};

export type TokenSnapshot = {
  symbol: 'FLZ';
  name: string;
  address: string;
  pair: string;
  chainName: string;
  explorerBaseUrl: string;
  priceEth: string | null;
  flzPerEth: string | null;
  reserveEth: string | null;
  reserveFlz: string | null;
  marketCapEth: string | null;
  liquidityEth: string | null;
  change1hPct: number | null;
  /** Figures for the selected range. */
  volumeEth: string | null;
  trades: number | null;
  range: ChartRange;
  candles: Candle[];
  /**
   * The chart's ends. A pool price only moves when somebody trades, so the line
   * starts at the last price before the window and runs to now at the pool price.
   */
  windowStart: number;
  windowEnd: number;
  startPriceEth: number | null;
  /** The last 24 hours, whatever range the chart shows. */
  day: DayStats | null;
  activity: ActivityRow[];
  chartError: boolean;
};

/** Everything one read of the pool learned, before a range is chosen. */
export type FlzDay = {
  pool: Omit<
    TokenSnapshot,
    | 'change1hPct'
    | 'volumeEth'
    | 'trades'
    | 'range'
    | 'candles'
    | 'windowStart'
    | 'windowEnd'
    | 'startPriceEth'
    | 'day'
    | 'activity'
    | 'chartError'
  >;
  prints: Print[];
  activity: ActivityRow[];
  now: number;
  chartError: boolean;
};

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** Swap logs over [from, to], read in chunks GIWA accepts. One failed chunk fails the read. */
async function swapLogs(provider: ethers.JsonRpcProvider, pair: string, from: number, to: number) {
  const topic = iface.getEvent('Swap')!.topicHash;
  const chunks = blockChunks(from, to, LOG_CHUNK);
  const parts = await inBatches(chunks, CHUNK_PARALLEL, async ([a, b]) => {
    try {
      return await provider.getLogs({ address: pair, topics: [topic], fromBlock: a, toBlock: b });
    } catch {
      // One retry: a single refused chunk should not blank the chart.
      return provider.getLogs({ address: pair, topics: [topic], fromBlock: a, toBlock: b });
    }
  });
  return parts.flat();
}

export async function loadFlzDay(): Promise<FlzDay> {
  const chain = getWebChain();
  const dex = getDexAddresses();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const day: FlzDay = {
    pool: {
      symbol: 'FLZ',
      name: 'FLZ',
      address: dex.flz,
      pair: dex.pair,
      chainName: chain.name,
      explorerBaseUrl: chain.explorerBaseUrl,
      priceEth: null,
      flzPerEth: null,
      reserveEth: null,
      reserveFlz: null,
      marketCapEth: null,
      liquidityEth: null,
    },
    prints: [],
    activity: [],
    now: Math.floor(Date.now() / 1000),
    chartError: false,
  };

  const pair = new ethers.Contract(dex.pair, SWAP_ABI, provider);
  let flzIs0: boolean;
  try {
    const [reserves, token0, supply, tokenName] = await Promise.all([
      pair.getReserves() as Promise<[bigint, bigint, number]>,
      pair.token0() as Promise<string>,
      new ethers.Contract(dex.flz, ERC20_ABI, provider).totalSupply() as Promise<bigint>,
      new ethers.Contract(dex.flz, ERC20_ABI, provider).name().catch(() => 'FLZ') as Promise<string>,
    ]);
    flzIs0 = ethers.getAddress(String(token0)) === dex.flz;
    const reserveFlz = flzIs0 ? reserves[0] : reserves[1];
    const reserveEth = flzIs0 ? reserves[1] : reserves[0];
    day.pool.name = tokenName || 'FLZ';
    day.pool.reserveFlz = ethers.formatEther(reserveFlz);
    day.pool.reserveEth = ethers.formatEther(reserveEth);
    if (reserveEth > 0n && reserveFlz > 0n) {
      const one = ethers.parseEther('1');
      day.pool.priceEth = ethers.formatEther((reserveEth * one) / reserveFlz);
      day.pool.flzPerEth = ethers.formatEther((reserveFlz * one) / reserveEth);
      day.pool.liquidityEth = ethers.formatEther(reserveEth);
      if (supply > 0n) day.pool.marketCapEth = ethers.formatEther((reserveEth * supply) / reserveFlz);
    }
  } catch {
    return { ...day, chartError: true };
  }

  try {
    const head = await provider.getBlock('latest');
    if (!head) throw new Error('no head');
    const headNumber = head.number;
    const fromNumber = Math.max(0, headNumber - DAY_SECONDS);
    const start = await provider.getBlock(fromNumber);
    if (!start) throw new Error('no start');
    // Block times are interpolated between two real blocks instead of one
    // getBlock per trade. GIWA closes a block every second, so this is exact
    // to within a block; measuring both ends keeps it right if that changes.
    const secondsPerBlock = headNumber > fromNumber ? (head.timestamp - start.timestamp) / (headNumber - fromNumber) : 1;
    const timeOf = (blockNumber: number) => Math.round(head.timestamp - (headNumber - blockNumber) * secondsPerBlock);
    day.now = head.timestamp;

    const logs = await swapLogs(provider, dex.pair, fromNumber, headNumber);
    const withPrints: Array<{ log: ethers.Log; print: Print }> = [];
    for (const log of logs) {
      let parsed: ethers.LogDescription | null = null;
      try {
        parsed = iface.parseLog(log);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.name !== 'Swap') continue;
      const print = printFromSwap({
        flzIsToken0: flzIs0,
        amount0In: parsed.args.amount0In as bigint,
        amount1In: parsed.args.amount1In as bigint,
        amount0Out: parsed.args.amount0Out as bigint,
        amount1Out: parsed.args.amount1Out as bigint,
        time: timeOf(log.blockNumber),
      });
      if (print) withPrints.push({ log, print });
    }
    day.prints = withPrints.map((w) => w.print);

    // Who traded, for the newest trades only: one receipt each.
    const plumbing = [dex.pair, dex.dexRouter, dex.feeRouter, dex.wrappedNative];
    const transferTopic = erc20.getEvent('Transfer')!.topicHash;
    const latest = withPrints.slice(-ACTIVITY_ROWS).reverse();
    day.activity = await inBatches(latest, 5, async ({ log, print }) => {
      let trader: string | null = null;
      try {
        const receipt = await provider.getTransactionReceipt(log.transactionHash);
        const transfers = (receipt?.logs || [])
          .filter((l) => ethers.getAddress(l.address) === dex.flz && l.topics[0] === transferTopic)
          .map((l) => {
            const t = erc20.parseLog(l);
            return { from: String(t?.args.from || ''), to: String(t?.args.to || '') };
          });
        trader = traderFromTransfers(transfers, print.side || 'sell', plumbing);
      } catch {
        trader = null;
      }
      return {
        time: print.time,
        side: print.side || 'sell',
        ethAmount: print.volumeEth,
        flzAmount: print.flzAmount || 0,
        trader,
        txHash: log.transactionHash,
        txUrl: `${chain.explorerBaseUrl}/tx/${log.transactionHash}`,
      };
    });
  } catch {
    day.chartError = true;
  }

  return day;
}

/** The page's view of one range, cut from the day. */
export function snapshotFor(day: FlzDay, range: ChartRange): TokenSnapshot {
  const since = (seconds: number) => day.prints.filter((p) => p.time >= day.now - seconds);
  const windowStart = day.now - rangeSeconds(range);
  const windowPrints = since(rangeSeconds(range));
  const before = day.prints.filter((p) => p.time < windowStart);
  const poolPrice = day.pool.priceEth == null ? null : Number(day.pool.priceEth);
  // The last trade before the window set the price the window opened at. With
  // none in the day, the first trade inside it is the best known opening; with
  // no trade at all the pool price has not moved.
  const startPriceEth = before.length
    ? before[before.length - 1].priceEth
    : windowPrints.length
      ? windowPrints[0].priceEth
      : poolPrice;
  const volume = windowPrints.reduce((total, p) => total + (Number.isFinite(p.volumeEth) && p.volumeEth > 0 ? p.volumeEth : 0), 0);
  return {
    ...day.pool,
    change1hPct: changePct(since(rangeSeconds('1h'))),
    volumeEth: day.chartError ? null : String(volume),
    trades: day.chartError ? null : windowPrints.length,
    range,
    candles: buildCandles(windowPrints, bucketForRange(range)),
    windowStart,
    windowEnd: day.now,
    startPriceEth,
    day: day.chartError ? null : dayStats(since(DAY_SECONDS)),
    activity: day.activity,
    chartError: day.chartError,
  };
}
