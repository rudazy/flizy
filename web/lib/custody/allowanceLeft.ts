/**
 * What is left of a secured account's daily passkey limit, for a payment the
 * site makes on Flizy's owner key (the pay page and checkout payments).
 *
 * The site has no relayer key, so these payments never go through the
 * account's signed permission and its period never counts them. What is left
 * is what the period reports, less the owner-key payments it cannot see over
 * the last 24 hours: checkout payments (site and chat) and payments on the
 * pay page. One period is a day, so 24 hours back covers whichever window is
 * current. Mirror of the bot's count (lib/custody/ownerKeySpend.js), which
 * chat sends, holds and checkouts subtract the same way;
 * test/passkeyCapPaths.test.js runs both on the same rows.
 *
 * Reads the database and the chain, sends nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { logApiError } from '../apiError.ts';
import { ASSETS, CONTRACTS, ROOT_AUTHORITY, delegationDigest, delegationStructHash, type AssetSymbol, type Delegation } from './delegations.ts';

const ENFORCER = new ethers.Interface([
  'function getAvailableAmount(bytes32 _delegationHash, address _delegationManager, bytes _terms) view returns (uint256 availableAmount_, bool isNewPeriod_, uint256 currentPeriod_)',
]);

/** A permission this close to its expiry is not used for a send, so it sets no limit (as lib/custody/redeem.js). */
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const LIVE_STATUSES = ['pending', 'submitted', 'confirmed'];

type ChainReader = { call(tx: { to: string; data: string }): Promise<string> };

/** A numeric column's text as base units, rounded up so a sum never comes out short. */
export function textToUnits(text: unknown, decimals: number): bigint {
  const [whole, frac = ''] = String(text ?? '0').trim().split('.');
  const units = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac.slice(0, decimals) || '0').padEnd(decimals, '0'));
  return /[1-9]/.test(frac.slice(decimals)) ? units + 1n : units;
}

/**
 * This account's owner-key payments in this asset over the last 24 hours, not
 * failed: checkout payments, and payments made on the pay page. Each row once.
 */
export async function ownerKeyUnitsToday(
  supabase: SupabaseClient,
  accountId: string,
  asset: string,
  decimals: number,
  now: number = Date.now()
): Promise<bigint> {
  const since = new Date(now - DAY_MS).toISOString();
  const base = () =>
    supabase
      .from('transfers')
      .select('id, amount_eth')
      .eq('account_id', accountId)
      .eq('asset', asset)
      .in('status', LIVE_STATUSES)
      .gte('created_at', since);
  const [checkouts, sitePays] = await Promise.all([
    base().eq('note', 'Checkout'),
    base().eq('phone', 'site').eq('kind', 'transfer'),
  ]);
  if (checkouts.error) throw new Error(checkouts.error.message);
  if (sitePays.error) throw new Error(sitePays.error.message);
  // A site checkout payment is in both lists: once by its id.
  const seen = new Map<unknown, unknown>();
  for (const r of [...(checkouts.data || []), ...(sitePays.data || [])] as Array<{ id?: string; amount_eth: unknown }>) {
    seen.set(r.id != null ? String(r.id) : r, r.amount_eth);
  }
  let sum = 0n;
  for (const amount of seen.values()) sum += textToUnits(amount, decimals);
  return sum;
}

/**
 * What is left today, or null when no limit applies: no live daily permission
 * for this asset and wallet (not a secured account, or an asset without one).
 * A permission that does not match its own digest, or a read that fails,
 * throws, and the caller sends nothing.
 */
export async function passkeyAllowanceLeft(
  supabase: SupabaseClient,
  provider: ChainReader,
  p: { accountId: string; wallet: string; symbol: string; decimals: number; now?: number }
): Promise<bigint | null> {
  const now = p.now ?? Date.now();
  if (!(p.symbol in ASSETS)) return null;
  const symbol = p.symbol as AssetSymbol;
  const { data: row, error } = await supabase
    .from('custody_delegations')
    .select('gator, delegate, salt, caveats, digest, signature, expires_at')
    .eq('account_id', p.accountId)
    .eq('symbol', symbol)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || !row.signature) return null;
  if (new Date(row.expires_at).getTime() - now < EXPIRY_MARGIN_MS) return null;
  const delegation: Delegation = {
    delegate: ethers.getAddress(row.delegate),
    delegator: ethers.getAddress(row.gator),
    authority: ROOT_AUTHORITY,
    caveats: ((row.caveats || []) as Array<{ enforcer: string; terms: string; args?: string }>).map((c) => ({
      enforcer: ethers.getAddress(c.enforcer),
      terms: c.terms,
      args: c.args || '0x',
    })),
    salt: BigInt(row.salt),
    signature: row.signature,
  };
  if (delegationDigest(delegation) !== row.digest) throw new Error('a stored permission does not match its own digest');
  if (delegation.delegator !== ethers.getAddress(p.wallet)) return null;
  const period = delegation.caveats[0];
  const data = ENFORCER.encodeFunctionData('getAvailableAmount', [delegationStructHash(delegation), CONTRACTS.delegationManager, period.terms]);
  const [available] = ENFORCER.decodeFunctionResult('getAvailableAmount', await provider.call({ to: period.enforcer, data }));
  const spent = await ownerKeyUnitsToday(supabase, p.accountId, symbol, p.decimals, now);
  const left = BigInt(available) - spent;
  return left > 0n ? left : 0n;
}

/**
 * The refusal for a site payment over the daily passkey limit, or null when it
 * fits or no limit applies. A check that cannot be made is logged and refuses:
 * nothing is sent on a limit nobody could read.
 *
 * @param next what the person can do instead, said after the refusal
 */
export async function passkeyLimitRefusal(
  supabase: SupabaseClient,
  provider: ChainReader,
  p: { route: string; accountId: string; wallet: string; symbol: string; label: string; amount: bigint; decimals: number; next: (left: string) => string }
): Promise<string | null> {
  let left: bigint | null;
  try {
    left = await passkeyAllowanceLeft(supabase, provider, p);
  } catch (err) {
    logApiError(p.route, err, { step: 'passkey limit', accountId: p.accountId });
    return 'Could not check your passkey limit right now, so nothing was sent. Try again shortly.';
  }
  if (left === null || p.amount <= left) return null;
  const shown = `${ethers.formatUnits(left, p.decimals)} ${p.label}`;
  return `This is more than your passkey allows today (${shown} left), so it was not sent. ${p.next(shown)}`;
}
