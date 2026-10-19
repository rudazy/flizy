/**
 * Which approval a money action needs: a plain confirm (Tier 0) or the PIN
 * (Tier 1). Account changes take the password (Tier 2) and are not decided
 * here.
 *
 * Mirror of lib/tiers.js, which web/ cannot import on Vercel.
 * test/tiersDrift.test.js keeps the two identical. "Known" is the SQL function
 * is_known_recipient, which chat calls too.
 *
 * Tier 0 covers only an ETH payment to a known recipient at or under the
 * quick-send amount, and a swap between ETH and a verified token (either
 * direction, any size) or a liquidity change on a verified pool when the price
 * check in web/lib/priceReference.ts passed, swaps up to QUICK_SWAPS_PER_HOUR
 * an hour. Everything else is Tier 1.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

/** DEFAULT_QUICK_SEND_ETH, read the way lib/config.js reads it. */
/** Swaps an account may make in a rolling hour, chat and site together, before the PIN applies again. */
export const QUICK_SWAPS_PER_HOUR = 4;
const QUICK_SWAP_WINDOW_MS = 60 * 60 * 1000;

function defaultQuickSendEth(): number {
  const raw = process.env.DEFAULT_QUICK_SEND_ETH;
  if (raw === undefined || raw === null || raw === '') return 0.005;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0.005;
}

/** ETH amount as wei, or null when it is not a usable non-negative amount. */
export function ethToWei(value: number | string | null | undefined): bigint | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  try {
    // A number like 1e-7 prints in exponent form, which parseEther refuses.
    return ethers.parseEther(typeof value === 'number' ? n.toFixed(18) : String(value).trim());
  } catch {
    return null;
  }
}

/**
 * The quick-send amount in wei. The account's own value applies when it is
 * set, but never above the app default: raising past the default comes with a
 * waiting period, which is not built yet.
 */
export function quickSendWei(
  account: { quick_send_eth?: number | string | null } | null | undefined,
  defaultEth: number = defaultQuickSendEth()
): bigint {
  const ceiling = ethToWei(defaultEth) ?? 0n;
  const own = account ? ethToWei(account.quick_send_eth) : null;
  if (own == null) return ceiling;
  return own < ceiling ? own : ceiling;
}

/** The quick-send ceiling in wei: the app default. */
export function quickSendCeilingWei(): bigint {
  return ethToWei(defaultQuickSendEth()) ?? 0n;
}

export type TierInput = {
  action: 'send' | 'swap' | 'liquidity' | 'other';
  native: boolean;
  amountWei: bigint;
  quickSendWei: bigint;
  known?: boolean;
  verified?: boolean;
  price?: { ok: boolean };
  swapsThisHour?: number | null;
};

export type TierResult = { tier: 0 | 1; reason: string };

export function evaluateTier(input: TierInput): TierResult {
  const { action, native, amountWei, quickSendWei: q } = input;
  // A swap between ETH and a verified token, or a liquidity change on a
  // verified pool, keeps the value in the account. What protects it is the
  // price (web/lib/priceReference.ts), not the PIN, so any size needs only a
  // price check that passed.
  if (action === 'swap' || action === 'liquidity') {
    if (action === 'swap' && input.verified !== true) return { tier: 1, reason: 'unverified_token' };
    if (input.price?.ok !== true) return { tier: 1, reason: 'price_check' };
    // Each swap inside the price band can still lose a few percent to someone
    // trading around it, so only a few an hour skip the PIN.
    if (action === 'swap' && !(Number.isInteger(input.swapsThisHour) && (input.swapsThisHour as number) < QUICK_SWAPS_PER_HOUR)) {
      return { tier: 1, reason: 'swap_limit' };
    }
    return { tier: 0, reason: 'value_stays' };
  }
  if (action !== 'send') return { tier: 1, reason: 'always_pin' };
  if (typeof amountWei !== 'bigint' || amountWei <= 0n) return { tier: 1, reason: 'bad_amount' };
  if (typeof q !== 'bigint' || q <= 0n) return { tier: 1, reason: 'quick_send_off' };
  if (!native) return { tier: 1, reason: 'unpriced' };
  if (amountWei > q) return { tier: 1, reason: 'over_quick_send' };
  if (input.known !== true) return { tier: 1, reason: 'new_recipient' };
  return { tier: 0, reason: 'quick_send' };
}

/**
 * Is this address one the account already pays? A read that fails throws, and
 * callers treat that as not known: the PIN is asked for, nothing is refused.
 */
export async function isKnownRecipient(
  supabase: SupabaseClient,
  accountId: string,
  address: string
): Promise<boolean> {
  if (!accountId || !ethers.isAddress(String(address || ''))) return false;
  const { data, error } = await supabase.rpc('is_known_recipient', {
    p_account_id: accountId,
    p_address: String(address).toLowerCase(),
  });
  if (error) throw new Error(error.message);
  return data === true;
}

/**
 * The tier of a payment to an address, read fresh: the account's quick-send
 * amount and whether the address is known. A failed read of either asks for
 * the PIN.
 */
export async function sendTier(
  supabase: SupabaseClient,
  accountId: string,
  address: string,
  native: boolean,
  amountWei: bigint
): Promise<TierResult> {
  let known = false;
  try {
    known = await isKnownRecipient(supabase, accountId, address);
  } catch {
    known = false;
  }
  const q = await accountQuickSendWei(supabase, accountId);
  return evaluateTier({ action: 'send', native, amountWei, quickSendWei: q, known });
}

/**
 * The tier of a swap on Flizy's pools. The quick-send amount plays no part:
 * the price check (web/lib/priceReference.ts swapPriceCheck) and the hourly
 * count (swapsInLastHour) decide.
 */
export function swapTier(verified: boolean, price: { ok: boolean } | null, swapsThisHour?: number | null): TierResult {
  // Amount and quick send are ignored for a swap; they are filled only for the type.
  return evaluateTier({
    action: 'swap',
    native: true,
    amountWei: 0n,
    quickSendWei: 0n,
    verified,
    price: price || undefined,
    swapsThisHour,
  });
}

/**
 * Swaps this account made in the last hour, in chat and on the site, any
 * status: every swap writes a transfers row of kind 'swap'. A read that fails
 * gives null, which asks for the PIN.
 */
export async function swapsInLastHour(supabase: SupabaseClient, accountId: string, now: number = Date.now()): Promise<number | null> {
  if (!accountId) return null;
  const { data, error } = await supabase
    .from('transfers')
    .select('id')
    .eq('account_id', accountId)
    .eq('kind', 'swap')
    .gte('created_at', new Date(now - QUICK_SWAP_WINDOW_MS).toISOString());
  if (error || !Array.isArray(data)) return null;
  return data.length;
}

/**
 * The tier of a liquidity change on a verified pool (web/lib/priceReference.ts
 * poolPriceCheck decides).
 */
export function liquidityTier(price: { ok: boolean } | null): TierResult {
  return evaluateTier({ action: 'liquidity', native: true, amountWei: 0n, quickSendWei: 0n, price: price || undefined });
}

export type QuickSendView = {
  /** The account's own value in ETH, or null for the app default. */
  ownEth: string | null;
  /** What applies now, in ETH. "0" means the PIN for every payment. */
  effectiveEth: string;
  /** The highest value an account may set, in ETH: the app default. */
  ceilingEth: string;
};

/**
 * The quick-send setting for the Limits screen and the money sheets. A read
 * that fails shows "0", which only ever asks for the PIN more often.
 */
export async function readQuickSend(supabase: SupabaseClient, accountId: string): Promise<QuickSendView> {
  const ceilingEth = ethers.formatEther(quickSendCeilingWei());
  const { data, error } = await supabase
    .from('accounts')
    .select('quick_send_eth')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return { ownEth: null, effectiveEth: '0.0', ceilingEth };
  const row = data as { quick_send_eth?: number | string | null };
  const own = ethToWei(row.quick_send_eth);
  return {
    ownEth: own == null ? null : ethers.formatEther(own),
    effectiveEth: ethers.formatEther(quickSendWei(row)),
    ceilingEth,
  };
}

/**
 * The account's quick-send amount, read fresh. A read that fails gives 0, so
 * the PIN is asked for.
 */
export async function accountQuickSendWei(supabase: SupabaseClient, accountId: string): Promise<bigint> {
  const { data, error } = await supabase
    .from('accounts')
    .select('quick_send_eth')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return 0n;
  return quickSendWei(data as { quick_send_eth?: number | string | null });
}
