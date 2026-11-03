/**
 * The Explore row's last 24 hours: a sparkline, the 24-hour change and the
 * number of trades, from the pool prices the indexer stored (or, when the
 * index cannot be read, from the swap prints read off the chain).
 *
 * The line is a step line: each point is the last known price at that moment,
 * carried forward between trades. With no trade in the window it is flat at
 * the price the window opened at, which is the current price, so a listed
 * token never shows an empty chart. The change compares the current price with
 * the last price before the window; when the pool's first trade falls inside
 * the window, with its first price.
 *
 * No imports, so node --test loads this file directly.
 */

export type PricePoint = { time: number; priceEth: number };

export type DaySeries = {
  /** Price at the end of each slice of the window, oldest first. Empty only when no price is known at all. */
  spark: number[];
  /** Percent change over the window, or null when there was no trade in it. */
  change24hPct: number | null;
  trades24h: number;
};

export const DAY_SECONDS = 24 * 60 * 60;
/** Points in the line: one every 30 minutes. */
export const SPARK_POINTS = 48;

function valid(p: PricePoint): boolean {
  return Number.isFinite(p.time) && Number.isFinite(p.priceEth) && p.priceEth > 0;
}

/**
 * @param prices pool prices with their times (seconds), in any order; points
 *   before the window are used only for the opening price
 * @param trades swaps inside the window
 * @param now end of the window, in seconds
 * @param currentPriceEth the pool price now, from its reserves; null when unread
 */
export function daySeries(prices: PricePoint[], trades: number, now: number, currentPriceEth: number | null): DaySeries {
  const start = now - DAY_SECONDS;
  const sorted = prices.filter(valid).sort((a, b) => a.time - b.time);
  const before = sorted.filter((p) => p.time < start);
  const inside = sorted.filter((p) => p.time >= start && p.time <= now);
  const current = currentPriceEth != null && Number.isFinite(currentPriceEth) && currentPriceEth > 0 ? currentPriceEth : null;

  const opening = before.length ? before[before.length - 1].priceEth : inside.length ? inside[0].priceEth : current;
  if (opening == null) return { spark: [], change24hPct: null, trades24h: Math.max(0, trades) };

  const step = DAY_SECONDS / SPARK_POINTS;
  const spark: number[] = [];
  let price = opening;
  let next = 0;
  for (let i = 1; i <= SPARK_POINTS; i += 1) {
    const at = start + i * step;
    while (next < inside.length && inside[next].time <= at) {
      price = inside[next].priceEth;
      next += 1;
    }
    spark.push(price);
  }
  // The line ends where the pool is now, when the reserves were read.
  if (current != null) spark[spark.length - 1] = current;

  const last = spark[spark.length - 1];
  const tradeCount = Math.max(0, trades);
  const change24hPct = tradeCount > 0 && opening > 0 ? ((last - opening) / opening) * 100 : null;
  return { spark, change24hPct, trades24h: tradeCount };
}

/** "1 trade", "7 trades". */
export function tradesLabel(count: number): string {
  return `${count} ${count === 1 ? 'trade' : 'trades'}`;
}
