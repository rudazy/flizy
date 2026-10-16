/**
 * Send a prepared Ammora swap through Flizy's own executor.
 *
 * Approvals first, one UserOp each: zero when an allowance is already there or
 * the token asks for a reset, then the exact amount (approvalSteps); never
 * unlimited. Then the swap itself, with onBroadcast so the caller records the
 * hash before it is sent. The SDK's execute() is never used.
 *
 * Mirror: web/lib/ammora/execute.ts.
 */

const { ethers } = require('ethers');
const { approvalSteps } = require('./venue');

const ERC20 = new ethers.Interface([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

/**
 * @param {{ accountId: string, provider: import('ethers').JsonRpcProvider, chainId: number, gator: string,
 *   prepared: { transaction: { to: string, data: string, value: bigint }, approvalRequirements: object[] },
 *   onBroadcast?: (hash: string) => Promise<void>|void }} args
 */
async function executeAmmoraSwap({ accountId, provider, chainId, gator, prepared, onBroadcast }) {
  const gx = require('../gatorExecute');
  for (const req of prepared.approvalRequirements) {
    const current = await gx.readAtLeast(provider, gx.lastReceiptBlock.get(gator), (blockTag) =>
      provider
        .call({ to: req.token, data: ERC20.encodeFunctionData('allowance', [gator, req.spender]), blockTag })
        .then((raw) => BigInt(raw))
    );
    for (const amount of approvalSteps(req, current)) {
      await gx.executeApprovalCall({
        accountId,
        provider,
        chainId,
        target: req.token,
        value: 0n,
        data: ERC20.encodeFunctionData('approve', [req.spender, amount]),
      });
    }
  }
  return gx.executeGatorCall({
    accountId,
    provider,
    chainId,
    target: prepared.transaction.to,
    value: prepared.transaction.value || 0n,
    data: prepared.transaction.data,
    onBroadcast,
  });
}

module.exports = { executeAmmoraSwap };
