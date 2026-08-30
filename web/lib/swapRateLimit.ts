/**
 * Rolling-window cap on site swaps.
 *
 * This replaces the account-password prompt that used to sit on
 * POST /api/swap/execute. The password came off because a swap cannot move
 * value to a third party: the route hardcodes `recipient: signer.address` and
 * never takes slippage from the caller (quoteSwap falls back to
 * SWAP_SLIPPAGE_BPS), so the worst a stolen session can do here is churn the
 * account's own balance at ~0.60% + gas a round trip. That is griefing, not
 * theft, and this cap is sized against griefing.
 *
 * The password stays on every route that CAN move value or widen authority:
 * trusted (the only route that adds a payout address), pay/execute, pin,
 * limits, identity, and swap/liquidity. Do not copy this file's reasoning onto
 * any of those — it holds only because the destination is fixed to the caller's
 * own wallet. If a recipient argument is ever added to the swap route, the
 * password has to come back with it.
 *
 * Database-backed, like web/lib/callbackLimiter.ts and for the same reason: a
 * Map in module scope enforces nothing on Vercel, where every serverless
 * instance keeps its own copy and a caller spreading requests across them is
 * never counted.
 *
 * It needs no table of its own. Every swap already writes a `transfers` row
 * with kind='swap', so that log IS the counter and there is no second piece of
 * state that can drift out of agreement with it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit extension: this module is also loaded straight by node --test,
// which does not resolve an extensionless relative specifier.
import { formatWait } from './channelBind.ts';

export const SWAP_RATE_LIMITED = 'SWAP_RATE_LIMITED';

export const SWAP_WINDOW_MS = 60 * 60 * 1000;

const DEFAULT_MAX_PER_WINDOW = 12;

/**
 * Swaps allowed per rolling hour. Override with SWAP_MAX_PER_HOUR.
 * A non-numeric or non-positive value falls back to the default rather than
 * disabling the cap, so a typo in the env cannot quietly remove it.
 */
export function swapsPerWindow(): number {
  const raw = Number(process.env.SWAP_MAX_PER_HOUR);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MAX_PER_WINDOW;
  return Math.floor(raw);
}

export type SwapRateResult =
  | { ok: true; used: number; max: number }
  | { ok: false; status: number; error: string; code: string; used: number; max: number };

/**
 * @param supabase service-role client
 * @param accountId account from the session cookie, never from the body
 * @param now injectable clock, for tests
 */
export async function checkSwapRateLimit(
  supabase: SupabaseClient,
  accountId: string,
  now: number = Date.now()
): Promise<SwapRateResult> {
  const max = swapsPerWindow();
  if (!accountId) return { ok: true, used: 0, max };

  const since = new Date(now - SWAP_WINDOW_MS).toISOString();

  // Every status counts, not just 'confirmed'. A swap that reverts still burns
  // the account's gas, and counting only the successful ones would let a caller
  // whose swaps keep failing spin without limit.
  const { data, error } = await supabase
    .from('transfers')
    .select('created_at')
    .eq('account_id', accountId)
    .eq('kind', 'swap')
    .gte('created_at', since);

  if (error) {
    // Degrades open, loudly, matching callbackLimiter. Safe to do here only
    // because what is lost is a griefing cap on the account's own balance, not
    // a barrier to anyone taking funds out — nothing on this route can.
    console.warn(`[swap] rate-limit read failed, cap NOT enforced: ${error.message}`);
    return { ok: true, used: 0, max };
  }

  const rows = data || [];
  if (rows.length < max) return { ok: true, used: rows.length, max };

  // Oldest row in the window is computed here rather than with .order() so the
  // answer does not depend on the server returning rows in any given order.
  let oldest = Infinity;
  for (const row of rows) {
    const ts = new Date(String(row.created_at)).getTime();
    if (Number.isFinite(ts) && ts < oldest) oldest = ts;
  }
  const retryMs = Number.isFinite(oldest)
    ? Math.max(1000, oldest + SWAP_WINDOW_MS - now)
    : SWAP_WINDOW_MS;

  return {
    ok: false,
    status: 429,
    error: `That is ${max} swaps in an hour, which is the limit. Try again in ${formatWait(retryMs)}.`,
    code: SWAP_RATE_LIMITED,
    used: rows.length,
    max,
  };
}
