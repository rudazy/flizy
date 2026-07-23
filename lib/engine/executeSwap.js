/**
 * Execute a confirmed SWAP plan via the Flizy fee router.
 */

const { ethers } = require('ethers');
const { ensureAgentWallet, getAgentSigner } = require('../agentWallet');
const { executeSwap, isAllowedSwapRouter } = require('../dex');
const { explorerTxUrl } = require('../chains');
const { publicErrorMessage } = require('../sanitize');
const { config } = require('../config');
const { insertTransfer, logSubmitted, logReceipt } = require('../transferLog');

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

  const transferRow = await insertTransfer({
    account_id: accountId,
    phone: plan.actor?.waSenderId || null,
    to_address: router,
    amount_eth: plan.input.amount,
    status: 'pending',
    chain_id: chain.chainId,
    kind: 'swap',
    asset: plan.input.tokenInLabel || 'ETH',
    amount_secondary: plan.input.amountOut || null,
    asset_secondary: plan.input.tokenOutLabel || null,
    counterparty_label: `swap → ${plan.input.tokenOutLabel || '?'}`,
    direction: 'out',
  });

  try {
    await ensureAgentWallet(accountId);
    const signer = getAgentSigner(accountId, provider);
    const amountIn = BigInt(plan.input.amountInWei);
    const amountOutMin = BigInt(plan.input.amountOutMinWei);

    if (plan.input.inIsNative) {
      const gasBuffer = ethers.parseEther(config.gasBufferEth);
      const bal = await provider.getBalance(signer.address);
      if (bal < amountIn + gasBuffer) {
        if (transferRow?.id) {
          await logReceipt(transferRow.id, {
            ok: false,
            txHash: '',
            error: 'insufficient balance',
          });
        }
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

    await logSubmitted(transferRow?.id, result.txHash);
    await logReceipt(transferRow?.id, { ok: true, txHash: result.txHash });

    return {
      ok: true,
      txHash: result.txHash,
      explorerUrl: explorerTxUrl(chain, result.txHash),
      submitted: true,
      confirmed: true,
    };
  } catch (err) {
    console.error('executeSwapPlan:', publicErrorMessage(err));
    if (transferRow?.id) {
      await logReceipt(transferRow.id, {
        ok: false,
        txHash: '',
        error: publicErrorMessage(err),
      });
    }
    return {
      ok: false,
      error: 'Swap failed on-chain. Check balance, allowance, and try again.',
    };
  }
}

module.exports = {
  executeSwapPlan,
};
