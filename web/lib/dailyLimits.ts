/**
 * Daily ETH send limit for site sends (UTC day).
 *
 * Mirror of lib/dailyLimits.js, which web/ cannot import on Vercel. What counts
 * as sent today is not computed here: both sides call the SQL function
 * daily_native_sent_eth (supabase/migrations/20260930120000_daily_native_sent.sql),
 * so chat and web cannot count differently. test/dailyLimitsDrift.test.js keeps
 * effectiveDailyLimitEth identical on both sides.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';

/** DEFAULT_DAILY_SEND_LIMIT_ETH, read the way lib/config.js reads it. */
function defaultDailyLimitEth(): number {
  const raw = process.env.DEFAULT_DAILY_SEND_LIMIT_ETH;
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Effective daily limit in ETH. null means no daily cap. An account value of 0
 * is a cap of 0: every ETH send is refused.
 */
export function effectiveDailyLimitEth(
  account: { daily_send_limit_eth?: number | string | null } | null | undefined,
  defaultLimit: number = defaultDailyLimitEth()
): number | null {
  if (account && account.daily_send_limit_eth != null && account.daily_send_limit_eth !== '') {
    const n = Number(account.daily_send_limit_eth);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (defaultLimit != null && Number(defaultLimit) > 0) return Number(defaultLimit);
  return null;
}

/** Native wei this account has sent today. Throws when it cannot be read. */
export async function dailyNativeSentWei(supabase: SupabaseClient, accountId: string): Promise<bigint> {
  const { data, error } = await supabase.rpc('daily_native_sent_eth', { p_account_id: accountId });
  if (error) throw new Error(error.message);
  return ethers.parseEther(String(data ?? '0'));
}

export type DailyLimitResult = { ok: true } | { ok: false; message: string };

/**
 * Would sending amountWei of ETH now go over today's limit? Reads the account's
 * own limit. Throws when the spent total cannot be read, so a caller that
 * cannot verify the limit does not send.
 */
export async function checkDailyNativeLimit(
  supabase: SupabaseClient,
  accountId: string,
  amountWei: bigint
): Promise<DailyLimitResult> {
  const { data: account, error } = await supabase
    .from('accounts')
    .select('daily_send_limit_eth')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const limitEth = effectiveDailyLimitEth(account);
  if (limitEth == null) return { ok: true };

  const spentWei = await dailyNativeSentWei(supabase, accountId);
  const limitWei = ethers.parseEther(String(limitEth));
  if (spentWei + amountWei <= limitWei) return { ok: true };

  const remaining = limitWei > spentWei ? limitWei - spentWei : 0n;
  return {
    ok: false,
    message: [
      'Daily ETH send limit reached.',
      `Limit: ${limitEth} ETH / day (UTC)`,
      `Already sent today: ${ethers.formatEther(spentWei)} ETH`,
      `Remaining: ${ethers.formatEther(remaining)} ETH`,
    ].join(' '),
  };
}
