/**
 * What the /api/mints/generated routes share: the signed-in account, the open
 * fee window, the usage quota, and what the chain supports.
 */

import { ethers } from 'ethers';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAccountIdFromCookie } from './cookies';
import { rejectIfCrossOrigin } from './requestOrigin.ts';
import { DROP_ABI, FACTORY_IFACE } from './mintDrop.ts';
import { MintError } from './mintExecute.ts';
import { ethUsd } from './ethUsd.ts';
import { feeWeiFor, openFeeWindow, takeUsage, usageQuota, type UsageKind } from './generationFee.ts';

/** The account id for a same-origin signed-in request, or the response to send instead. */
export async function generationCaller(req: Request): Promise<{ accountId: string } | { refuse: Response }> {
  const denied = rejectIfCrossOrigin(req);
  if (denied) return { refuse: denied };
  const accountId = await getAccountIdFromCookie();
  if (!accountId) return { refuse: NextResponse.json({ error: 'Not logged in' }, { status: 401 }) };
  return { accountId };
}

/**
 * Take `amount` units of `kind` from the open fee window. Refuses when no fee
 * is paid or the window's quota is spent.
 */
export async function spendFromWindow(
  supabase: SupabaseClient,
  accountId: string,
  kind: UsageKind,
  amount: number
): Promise<{ paidAt: string; supply: number }> {
  const window = await openFeeWindow(supabase, accountId);
  if (!window) throw new MintError('Pay the generation fee first.', 402);
  const ok = await takeUsage(supabase, accountId, window.paidAt, kind, amount, usageQuota(kind, window.supply));
  if (!ok) throw new MintError('This generation has used everything the fee covers. Pay again to keep going.', 429);
  return window;
}

/** $2 in test ETH at the current rate, or null when there is no rate. */
export async function feeQuote(): Promise<{ usdPerEth: number; feeWei: bigint } | null> {
  const usdPerEth = await ethUsd();
  const feeWei = feeWeiFor(usdPerEth);
  return usdPerEth != null && feeWei != null ? { usdPerEth, feeWei } : null;
}

/** Where the fee goes: FlizyDrop's fee recipient, read from the chain. */
export async function feeRecipient(provider: ethers.Provider, drop: string): Promise<string> {
  const raw = await new ethers.Contract(drop, DROP_ABI, provider).feeRecipient();
  return ethers.getAddress(String(raw));
}

const metadataSupport = new Map<string, boolean>();

/**
 * Whether the deployed factory has createWithMetadata. Read from its bytecode,
 * which carries every function selector it dispatches on, so an older factory
 * is told apart without a call that would revert.
 */
export async function factorySupportsMetadata(provider: ethers.Provider, factory: string): Promise<boolean> {
  const cached = metadataSupport.get(factory);
  if (cached != null) return cached;
  const code = (await provider.getCode(factory)).toLowerCase();
  const selector = FACTORY_IFACE.getFunction('createWithMetadata')!.selector.slice(2).toLowerCase();
  const yes = code.length > 2 && code.includes(`63${selector}`);
  // Only a yes is cached: deployed code never changes, and a no read before the deploy landed must not stick.
  if (yes) metadataSupport.set(factory, true);
  return yes;
}
