/**
 * Which approval a money action needs: a plain confirm (Tier 0) or the PIN
 * (Tier 1). Account changes take the password (Tier 2) and are not decided
 * here.
 *
 * Mirror of lib/tiers.js, which web/ cannot import on Vercel.
 * test/tiersDrift.test.js keeps the two identical. "Known" is the SQL function
 * is_known_recipient, which chat calls too.
 *
 * Tier 0 covers only an ETH payment to a known recipient, or an ETH swap into
 * verified tokens, at or under the quick-send amount. Everything else is
 * Tier 1.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

/** DEFAULT_QUICK_SEND_ETH, read the way lib/config.js reads it. */
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
  action: 'send' | 'swap' | 'other';
  native: boolean;
  amountWei: bigint;
  quickSendWei: bigint;
  known?: boolean;
  verified?: boolean;
};

export type TierResult = { tier: 0 | 1; reason: string };

export function evaluateTier(input: TierInput): TierResult {
  const { action, native, amountWei, quickSendWei: q } = input;
  if (action !== 'send' && action !== 'swap') return { tier: 1, reason: 'always_pin' };
  if (typeof amountWei !== 'bigint' || amountWei <= 0n) return { tier: 1, reason: 'bad_amount' };
  if (typeof q !== 'bigint' || q <= 0n) return { tier: 1, reason: 'quick_send_off' };
  if (!native) return { tier: 1, reason: 'unpriced' };
  if (amountWei > q) return { tier: 1, reason: 'over_quick_send' };
  if (action === 'send' && input.known !== true) return { tier: 1, reason: 'new_recipient' };
  if (action === 'swap' && input.verified !== true) return { tier: 1, reason: 'unverified_token' };
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
 * The tier of a swap, read fresh. Only an ETH input has a value to hold
 * against the quick-send amount; selling a token is always the PIN for now.
 */
export async function swapTier(
  supabase: SupabaseClient,
  accountId: string,
  nativeIn: boolean,
  amountInWei: bigint,
  verified: boolean
): Promise<TierResult> {
  const q = await accountQuickSendWei(supabase, accountId);
  return evaluateTier({ action: 'swap', native: nativeIn, amountWei: amountInWei, quickSendWei: q, verified });
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
