import { LISTED_TOKENS } from './listedTokens.ts';
import { DAY_SECONDS, daySeries } from './priceSeries.ts';
import type { PairWindow } from './pairEvents.ts';

/**
 * The Explore list's rows, one per listed pool.
 *
 * The pool figures (price, liquidity, market cap) come from the pool itself,
 * read now, exactly as before. The 24-hour line, change and trade count come
 * from the event index when it holds that pair and is current (indexed, keyed
 * by lower-case pair address), and otherwise from the swap prints the chain
 * read returned, so a row never reads an index that has not caught up. change1hPct stays as it was for
 * the trending strip and the Gainers filter.
 */

/** The parts of a cached day this file reads. */
export type DayLike = {
  pool: {
    symbol: string;
    name: string;
    pair: string;
    priceEth: string | null;
    flzPerEth: string | null;
    liquidityEth: string | null;
    marketCapEth: string | null;
  };
  prints: Array<{ time: number; priceEth: number }>;
  now: number;
  chartError: boolean;
  /** Some log chunks were refused: the prints are incomplete. */
  partial?: boolean;
};

export type IndexedLike = { now: number; windows: Record<string, PairWindow> } | null;

function row(day: DayLike, change1hPct: number | null, indexed: IndexedLike) {
  const current = day.pool.priceEth == null ? null : Number(day.pool.priceEth);
  const window = indexed?.windows[String(day.pool.pair).toLowerCase()];
  let spark: number[];
  let change24hPct: number | null;
  let trades24h: number | null;
  if (window && indexed) {
    ({ spark, change24hPct, trades24h } = daySeries(window.prices, window.trades, indexed.now, current));
  } else {
    // The chain read's own prints. When that read failed, or some of its
    // chunks did, the trades are not fully known, so the count and the change
    // are left out rather than undercounted; the line is still drawn.
    const inDay = day.prints.filter((p) => p.time >= day.now - DAY_SECONDS).length;
    const series = daySeries(day.prints, inDay, day.now, current);
    const unknown = day.chartError || Boolean(day.partial);
    spark = series.spark;
    change24hPct = unknown ? null : series.change24hPct;
    trades24h = unknown ? null : series.trades24h;
  }
  return {
    symbol: day.pool.symbol,
    name: day.pool.name,
    priceEth: day.pool.priceEth,
    change1hPct,
    change24hPct,
    trades24h,
    liquidityEth: day.pool.liquidityEth,
    flzPerEth: day.pool.flzPerEth,
    marketCapEth: day.pool.marketCapEth,
    spark,
  };
}

export function listTokens<D extends DayLike>(args: {
  flzDay: D;
  listedDays: Array<D | null>;
  indexed: IndexedLike;
  watched: string[];
  oneHour: (day: D) => { change1hPct: number | null };
}) {
  const { flzDay, listedDays, indexed, watched, oneHour } = args;
  const listed = LISTED_TOKENS.flatMap((token, i) => {
    const d = listedDays[i];
    if (!d) return [];
    return [{ ...row(d, oneHour(d).change1hPct, indexed), symbol: token.symbol, name: token.name, address: token.address, verified: token.verified }];
  });
  return [
    {
      ...row(flzDay, oneHour(flzDay).change1hPct, indexed),
      verified: true,
      // Starred by this account, for the Watchlist filter.
      watched: watched.includes('flz'),
    },
    ...listed,
  ];
}
