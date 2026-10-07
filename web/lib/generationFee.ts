/**
 * The collection generation fee: $2, paid in ETH from the creator's Flizy
 * wallet to the Flizy fee wallet (FlizyDrop's fee recipient) in one
 * confirmed transaction. It is not network gas, which the wallet pays on top.
 *
 * On GIWA Sepolia the ETH has no market price, so the fee is the mainnet rate's
 * worth of test ETH: $2 at the current ETH/USD rate, rounded up. No rate, no
 * fee quote, and nothing is charged.
 *
 * Paying opens a generation window: for GENERATION_WINDOW_MS the creator's
 * images and metadata can be stored, and the AI can draw trait layers. The
 * payment is the transfers row runMintTx already writes, found again by its
 * label, so there is no second record to drift from the chain.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { MARKET_KIND } from './marketRateLimit.ts';

export const GENERATION_FEE_USD = 2;
export const GENERATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FEE_LABEL_PREFIX = 'Collection generation fee: ';

/** Wei for `usd` dollars at `usdPerEth`, rounded up to a whole microether. Null without a usable rate. */
export function feeWeiFor(usdPerEth: number | null, usd = GENERATION_FEE_USD): bigint | null {
  if (usdPerEth == null || !Number.isFinite(usdPerEth) || usdPerEth <= 0) return null;
  // Integer maths in micro-ETH: usd / rate ETH, rounded up.
  const microEth = Math.ceil((usd / usdPerEth) * 1e6);
  if (!Number.isSafeInteger(microEth) || microEth <= 0) return null;
  return BigInt(microEth) * 10n ** 12n;
}

/** The history label of a fee payment. The supply in it is what the window covers. */
export function feeLabel(name: string, supply: number): string {
  return `${FEE_LABEL_PREFIX}${name} (${supply} NFTs)`;
}

export function supplyFromLabel(label: string): number | null {
  if (!label.startsWith(FEE_LABEL_PREFIX)) return null;
  const m = / \((\d{1,5}) NFTs\)$/.exec(label);
  return m ? Number(m[1]) : null;
}

export type UsageKind = 'pin_image' | 'pin_metadata' | 'ai_plan' | 'ai_image';

/** What one fee window allows. Images: every token plus the cover, with room for retries. */
export function usageQuota(kind: UsageKind, supply: number): number {
  if (kind === 'pin_image') return Math.ceil(supply * 1.1) + 10;
  if (kind === 'pin_metadata') return 3;
  if (kind === 'ai_image') return 120;
  return 10;
}

/** Start of the UTC day, the window AI plans are counted in. */
export function planWindow(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Count `amount` units of paid usage against a window. False when the quota
 * would be exceeded. Throws when the counter cannot be read: every unit here
 * costs Flizy money, so an unreadable counter refuses rather than waves through.
 */
export async function takeUsage(
  supabase: SupabaseClient,
  accountId: string,
  windowPaidAt: string,
  kind: UsageKind,
  amount: number,
  max: number
): Promise<boolean> {
  const { data, error } = await supabase.rpc('bump_generation_usage', {
    p_account_id: accountId,
    p_window_paid_at: windowPaidAt,
    p_kind: kind,
    p_amount: amount,
    p_max: max,
  });
  if (error) throw new Error(`generation usage count failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as { allowed?: unknown } | null;
  return row?.allowed === true;
}

export type FeeWindow = { paidAt: string; until: string; supply: number } | null;

/** The newest confirmed fee payment still inside its window, or null. */
export async function openFeeWindow(supabase: SupabaseClient, accountId: string, now = Date.now()): Promise<FeeWindow> {
  const since = new Date(now - GENERATION_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('transfers')
    .select('created_at, counterparty_label, status')
    .eq('account_id', accountId)
    .eq('kind', MARKET_KIND)
    .eq('status', 'confirmed')
    .like('counterparty_label', `${FEE_LABEL_PREFIX}%`)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`fee window lookup failed: ${error.message}`);
  const row = (data || [])[0] as { created_at?: string; counterparty_label?: string } | undefined;
  if (!row?.created_at || !row.counterparty_label) return null;
  const supply = supplyFromLabel(row.counterparty_label);
  if (supply == null) return null;
  const paid = Date.parse(row.created_at);
  return { paidAt: row.created_at, until: new Date(paid + GENERATION_WINDOW_MS).toISOString(), supply };
}
