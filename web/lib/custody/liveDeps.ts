/**
 * The chain and the channels, as web/lib/custody/ceremony.ts uses them on the
 * live site. Kept apart from the ceremony so its tests never need a node.
 */

import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getWebChain } from '../dexServer';
import { executeGatorCall, pointerIsGator } from '../gatorExecute.ts';
import { tryAccountTxLock, releaseAccountTxLock } from '../accountTxLock.ts';
import { notifyAllChannels } from '../notifyChannels';
import { ClientError } from '../apiError.ts';
import type { CeremonyDeps } from './ceremony.ts';

export function liveCeremonyDeps(supabase: SupabaseClient): CeremonyDeps {
  const chain = getWebChain();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });

  return {
    // Only a wallet that already is the account's HybridDeleGator can take a key:
    // a passkey on a gator the funds are not in would secure nothing.
    gatorOf: async (accountId) => {
      const { data, error } = await supabase.from('accounts').select('agent_wallet_address').eq('id', accountId).maybeSingle();
      if (error) throw new Error(error.message);
      const stored = data?.agent_wallet_address ?? null;
      return pointerIsGator(accountId, stored) ? ethers.getAddress(String(stored)) : null;
    },

    // The account's own UserOp, under the same per-account lock payments take,
    // so it never races a send for the account's nonce.
    execAsAccount: async ({ accountId, target, data, onBroadcast }) => {
      const lock = await tryAccountTxLock(supabase, accountId, 'custody');
      if (!lock.ok) throw new ClientError(lock.error);
      try {
        const sent = await executeGatorCall({ accountId, provider, chainId: chain.chainId, target, value: 0n, data, onBroadcast });
        return { txHash: sent.txHash };
      } finally {
        await releaseAccountTxLock(supabase, accountId);
      }
    },

    call: (to, data) => provider.call({ to, data }),

    notify: async (accountId, body) => {
      await notifyAllChannels(accountId, body).catch(() => 0);
    },
  };
}
