/**
 * Sends marketplace transactions from the account's own wallet.
 *
 * Two wallet shapes exist (see web/app/api/swap/execute/route.ts): the
 * server-derived EOA, and the HybridDeleGator once the account's pointer moved
 * there, where the EOA only signs the UserOp. Each call here goes out from
 * whichever one holds the assets, and is waited on, so the next call in a
 * sequence (approve, then list) never races the one before it.
 */

import { ethers } from 'ethers';
import { deriveAgentWallet } from './dexServer';
import { executeApprovalCall, executeGatorCall, gatorGasReserveWei } from './gatorExecute.ts';
import { ClientError } from './apiError';
import { assertSpendable } from './reserveStore.ts';

export type MarketCall = { target: string; value: bigint; data: string };

/** Rough upper bound on gas for one EOA marketplace call, for the balance check. */
const EOA_GAS_LIMIT = 400_000n;

/**
 * Refuses up front when the wallet cannot cover `value` plus gas, with a
 * message the person can act on, instead of a revert deep in the send.
 */
export async function assertCanPay(
  provider: ethers.JsonRpcProvider,
  wallet: { address: string; viaGator: boolean },
  value: bigint,
  calls: number,
  fence?: { supabase: { from: (table: string) => unknown }; accountId: string } | null
): Promise<void> {
  const balance = await provider.getBalance(wallet.address);
  let gas: bigint;
  if (wallet.viaGator) {
    gas = (await gatorGasReserveWei(provider, wallet.address)) * BigInt(calls);
  } else {
    const fee = await provider.getFeeData();
    const price = fee.maxFeePerGas || fee.gasPrice || ethers.parseUnits('1', 'gwei');
    gas = price * EOA_GAS_LIMIT * BigInt(calls);
  }
  if (fence?.accountId) {
    const available = await assertSpendable(fence.supabase, fence.accountId, {
      asset: 'ETH',
      holding: balance,
      amount: value,
      gas,
      decimals: 18,
      label: 'ETH',
    });
    if (!available.ok) throw new ClientError(available.message);
  }
  if (balance < value + gas) {
    const need = ethers.formatEther(value + gas);
    throw new ClientError(`Not enough ETH. This needs about ${need} ETH including network fees.`);
  }
}

export async function runMarketCalls(args: {
  accountId: string;
  provider: ethers.JsonRpcProvider;
  chainId: number;
  viaGator: boolean;
  calls: MarketCall[];
  /**
   * Called with the last call's tx hash before it is broadcast (persist it).
   * The calls before it are approvals and move nothing on their own.
   */
  onBroadcast?: (txHash: string) => Promise<void> | void;
}): Promise<string> {
  let txHash = '';
  for (const [i, call] of args.calls.entries()) {
    const last = i === args.calls.length - 1;
    if (args.viaGator) {
      const params = {
        accountId: args.accountId,
        provider: args.provider,
        chainId: args.chainId,
        target: call.target,
        value: call.value,
        data: call.data,
      };
      const result = last
        ? await executeGatorCall({ ...params, onBroadcast: args.onBroadcast })
        : await executeApprovalCall(params);
      txHash = result.txHash;
    } else {
      const signer = deriveAgentWallet(args.accountId).connect(args.provider);
      const tx = await signer.sendTransaction({ to: call.target, value: call.value, data: call.data });
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error('Marketplace transaction reverted');
      txHash = tx.hash;
    }
  }
  return txHash;
}
