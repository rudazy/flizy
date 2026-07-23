/**
 * Execute a confirmed SWAP plan via the Flizy fee router.
 */

const { ethers } = require('ethers');
const { ensureAgentWallet, getAgentSigner } = require('../agentWallet');
const { executeSwap, isAllowedSwapRouter } = require('../dex');
const { explorerTxUrl } = require('../chains');
const { publicErrorMessage } = require('../sanitize');
const { config } = require('../config');

/**
 * @param {object} args
 * @param {object} args.plan  SWAP execution plan
 * @param {import('ethers').Provider} args.provider
 * @param {object} args.chain
 */
async function executeSwapPlan({ plan, provider, chain }) {
  if (!plan || plan.intent !== 'SWAP') {
    return { ok: false, error: 'Not a swap plan.' };
  }
  const router = plan.route?.routerAddress;
  if (!isAllowedSwapRouter(router, chain?.id || chain?.chainId)) {
    return { ok: false, error: 'Router not allowlisted.' };
  }

  const accountId = plan.actor?.accountId;
  if (!accountId) return { ok: false, error: 'Not linked.' };

  try {
    await ensureAgentWallet(accountId);
    const signer = getAgentSigner(accountId, provider);
    const amountIn = BigInt(plan.input.amountInWei);
    const amountOutMin = BigInt(plan.input.amountOutMinWei);

    if (plan.input.inIsNative) {
      const gasBuffer = ethers.parseEther(config.gasBufferEth);
      const bal = await provider.getBalance(signer.address);
      if (bal < amountIn + gasBuffer) {
        return {
          ok: false,
          error: [
            'Not enough ETH in your agent wallet (amount + gas).',
            `Fund: ${signer.address}`,
          ].join('\n'),
        };
      }
    }

    const result = await executeSwap({
      signer,
      amountIn,
      tokenIn: plan.input.inIsNative ? null : plan.input.tokenIn,
      tokenOut: plan.input.outIsNative ? null : plan.input.tokenOut,
      amountOutMinWei: amountOutMin,
      chainKey: chain?.id,
      recipient: signer.address,
    });

    return {
      ok: true,
      txHash: result.txHash,
      explorerUrl: explorerTxUrl(chain, result.txHash),
      submitted: true,
      confirmed: true,
    };
  } catch (err) {
    console.error('executeSwapPlan:', publicErrorMessage(err));
    return {
      ok: false,
      error: 'Swap failed on-chain. Check balance, allowance, and try again.',
    };
  }
}

module.exports = {
  executeSwapPlan,
};
