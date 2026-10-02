/**
 * Rolling-hour cap on marketplace actions (list, buy, offer, cancel, accept).
 *
 * A churn limit, not the authority check: every action also takes the account
 * password. Like web/lib/swapRateLimit.ts it counts the `transfers` rows the
 * actions already write (kind 'nft_market'), so there is no second counter to
 * drift, and it holds across serverless instances.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatWait } from './channelBind.ts';

const MARKET_RATE_LIMITED = 'MARKET_RATE_LIMITED';
export const MARKET_KIND = 'nft_market';
const MARKET_WINDOW_MS = 60 * 60 * 1000;
const MARKET_MAX_PER_WINDOW = 30;

export type MarketRateResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string };

export async function checkMarketRateLimit(
  supabase: SupabaseClient,
  accountId: string,
  now: number = Date.now()
): Promise<MarketRateResult> {
  const since = new Date(now - MARKET_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('transfers')
    .select('created_at')
    .eq('account_id', accountId)
    .eq('kind', MARKET_KIND)
    .gte('created_at', since);
  if (error) {
    // Unlike swaps, a buy moves ETH to someone else, so an unreadable counter
    // closes the route instead of waving the action through.
    return { ok: false, status: 503, error: 'Could not start this. Try again shortly.', code: MARKET_RATE_LIMITED };
  }
  const rows = data || [];
  if (rows.length < MARKET_MAX_PER_WINDOW) return { ok: true };
  let oldest = Infinity;
  for (const row of rows) {
    const ts = new Date(String(row.created_at)).getTime();
    if (Number.isFinite(ts) && ts < oldest) oldest = ts;
  }
  const retryMs = Number.isFinite(oldest) ? Math.max(1000, oldest + MARKET_WINDOW_MS - now) : MARKET_WINDOW_MS;
  return {
    ok: false,
    status: 429,
    error: `That is ${MARKET_MAX_PER_WINDOW} marketplace actions in an hour, which is the limit. Try again in ${formatWait(retryMs)}.`,
    code: MARKET_RATE_LIMITED,
  };
}
