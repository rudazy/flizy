/**
 * Send a prepared Ammora swap through Flizy's own executor.
 * Mirror of lib/ammora/execute.js: exact approvals (zero first when needed)
 * as their own UserOps, then the swap with onBroadcast. Never the SDK's
 * execute().
 */

import { ethers } from 'ethers';
import { approvalSteps } from './venue.ts';
import { executeApprovalCall, executeGatorCall, lastReceiptBlock, readAtLeast } from '../gatorExecute.ts';
import type { PreparedAmmoraSwap } from './routes.ts';

const ERC20 = new ethers.Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export async function executeAmmoraSwap(args: {
  accountId: string;
  provider: ethers.JsonRpcProvider;
  chainId: number;
  gator: string;
  prepared: Pick<PreparedAmmoraSwap, 'transaction' | 'approvalRequirements'>;
  onBroadcast?: (hash: string) => Promise<void> | void;
}) {
  const { accountId, provider, chainId, gator, prepared, onBroadcast } = args;
  for (const req of prepared.approvalRequirements) {
    const current = await readAtLeast(provider, lastReceiptBlock.get(gator), (blockTag) =>
      provider
        .call({ to: req.token, data: ERC20.encodeFunctionData('allowance', [gator, req.spender]), blockTag })
        .then((raw) => BigInt(raw))
    );
    for (const amount of approvalSteps(req, current)) {
      await executeApprovalCall({
        accountId,
        provider,
        chainId,
        target: req.token,
        value: 0n,
        data: ERC20.encodeFunctionData('approve', [req.spender, amount]),
      });
    }
  }
  return executeGatorCall({
    accountId,
    provider,
    chainId,
    target: prepared.transaction.to,
    value: prepared.transaction.value || 0n,
    data: prepared.transaction.data,
    onBroadcast,
  });
}
