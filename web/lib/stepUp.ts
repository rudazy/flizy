/**
 * Step-up for actions that move value: the PIN (a passkey too, from a later
 * slice), never the account password.
 *
 * Tiers: the password guards account changes (trusted list, limits, PIN,
 * email, username, linking, pausing). Money actions ask for the PIN, which is
 * short, typed only on flizy.app, and has its own pause per account
 * (web/lib/pinGate.ts). A stolen session cookie still cannot move value
 * without it, except a small ETH payment to someone the account already pays
 * (requireApproval below). Swaps and liquidity changes pay nobody and take no
 * PIN on testnet.
 *
 * Same result shape as requirePassword, so a route swaps one call for the
 * other. Codes the site's sheets act on:
 *   PIN_REQUIRED  nothing was sent
 *   NO_PIN        the account has no PIN yet: set one on Account (password)
 *   PIN_WRONG     with attemptsLeft
 *   PIN_LOCKED    paused; setting a new PIN with the password lifts it
 */

import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit extension: this module is also loaded straight by node --test.
import { checkPin } from './pinGate.ts';
import type { TierResult } from './tiers.ts';

export type StepUpResult =
  | { ok: true }
  | { ok: false; status: number; error: string; code: string; attemptsLeft?: number };

/**
 * @param supabase service-role client
 * @param accountId account from the session cookie, never from the body
 * @param pin as typed on the page
 * @param action what it is being spent on, for the copy ("pay")
 */
export async function requireStepUp(
  supabase: SupabaseClient,
  accountId: string,
  pin: string,
  action: string
): Promise<StepUpResult> {
  if (!pin) {
    return { ok: false, status: 400, error: `Enter your PIN to ${action}.`, code: 'PIN_REQUIRED' };
  }
  const check = await checkPin(supabase, accountId, String(pin));
  if (check.ok) return { ok: true };
  if (check.reason === 'no_pin') {
    return { ok: false, status: 400, error: 'Set a PIN on Account first. It approves payments.', code: 'NO_PIN' };
  }
  if (check.reason === 'locked') {
    return { ok: false, status: 429, error: check.error, code: 'PIN_LOCKED' };
  }
  if (check.reason === 'wrong') {
    return { ok: false, status: 401, error: check.error, code: 'PIN_WRONG', attemptsLeft: check.attemptsLeft };
  }
  return { ok: false, status: 400, error: check.error, code: 'PIN_REQUIRED' };
}

/**
 * The approval a tiered money route asks for: nothing more than the session
 * for Tier 0 (a small ETH payment to a known recipient; web/lib/tiers.ts), the
 * PIN for everything else.
 *
 * tier must come from evaluateTier on this request, worked out on the server
 * from what will actually be sent. Nothing the browser says decides it.
 */
export async function requireApproval(
  supabase: SupabaseClient,
  accountId: string,
  pin: string,
  action: string,
  tier: TierResult
): Promise<StepUpResult> {
  if (tier.tier === 0) return { ok: true };
  return requireStepUp(supabase, accountId, pin, action);
}
