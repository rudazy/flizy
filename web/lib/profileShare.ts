/**
 * The wallet address and ETH balance a public profile may show.
 *
 * Called only when the viewer is allowed to see one of them. A failed or
 * slow chain read leaves the balance empty. It does not fail the profile.
 * The provider is closed when the read ends, so an unreachable node does
 * not keep retrying after the page has moved on.
 */

import { getSupabase } from './supabase.ts';
import { getWebChain } from './webChain.ts';

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
  if (opts.portfolio) portfolioEth = await nativeBalance(raw);
  return { wallet: opts.wallet ? raw : null, portfolioEth };
}

async function nativeBalance(address: string): Promise<number | null> {
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
    const eth = Number(ethers.formatEther(bal));
    return Number.isFinite(eth) && eth >= 0 ? eth : null;
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
