/**
 * The wallet address and ETH balance a public profile may show.
 *
 * Called only when the viewer is allowed to see one of them. The balance is
 * Available: the chain balance minus the ETH in Savings, so a profile never
 * tells anyone what is set aside. A failed or slow chain read, or a Savings
 * read that fails, leaves the balance empty rather than showing a total that
 * counts Savings. It does not fail the profile. The provider is closed when
 * the read ends, so an unreachable node does not keep retrying after the page
 * has moved on.
 */

import { getSupabase } from './supabase.ts';
import { getWebChain } from './webChain.ts';
import { loadReserveRows } from './reserveStore.ts';
import { availableBase, SAVINGS_ASSET } from './reservesMath.ts';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export type ProfileShare = {
  wallet: string | null;
  portfolioEth: number | null;
};

export async function profileShare(
  accountId: string,
  opts: { wallet: boolean; portfolio: boolean }
): Promise<ProfileShare> {
  if (!opts.wallet && !opts.portfolio) return { wallet: null, portfolioEth: null };
  const { data, error } = await getSupabase()
    .from('accounts')
    .select('agent_wallet_address')
    .eq('id', accountId)
    .maybeSingle();
  if (error || !data) return { wallet: null, portfolioEth: null };
  const raw = String((data as { agent_wallet_address?: string | null }).agent_wallet_address || '');
  if (!ADDRESS.test(raw)) return { wallet: null, portfolioEth: null };
  let portfolioEth: number | null = null;
  if (opts.portfolio) {
    const [wei, saved] = await Promise.all([nativeBalance(raw), ethInSavings(accountId)]);
    if (wei !== null && saved !== null) portfolioEth = toEth(availableBase(wei, saved));
  }
  return { wallet: opts.wallet ? raw : null, portfolioEth };
}

/** ETH in Savings in wei: 0 with no Savings book, null when it cannot be read. */
async function ethInSavings(accountId: string): Promise<bigint | null> {
  try {
    const loaded = await loadReserveRows(getSupabase(), accountId);
    if (!loaded.ok) return null;
    const row = loaded.rows.find((r) => r.asset === SAVINGS_ASSET);
    return row ? BigInt(row.amount) : 0n;
  } catch {
    return null;
  }
}

function toEth(wei: bigint): number | null {
  const eth = Number(wei) / 1e18;
  return Number.isFinite(eth) && eth >= 0 ? eth : null;
}

async function nativeBalance(address: string): Promise<bigint | null> {
  const { ethers } = await import('ethers');
  const chain = getWebChain();
  // staticNetwork skips the detect-network retry. A deadline alone does not
  // stop that retry, so the provider is closed in finally as well.
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = provider.getBalance(ethers.getAddress(address));
    pending.catch(() => undefined);
    const bal = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('balance timed out')), 4000);
      }),
    ]);
    return bal >= 0n ? bal : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      provider.destroy();
    } catch {
      // The balance is already decided. Closing the provider must not replace it.
    }
  }
}
