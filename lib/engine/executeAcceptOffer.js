/**
 * Execute a confirmed NFT_ACCEPT_OFFER plan: sell one NFT into an offer on the
 * Flizy marketplace from the account's own wallet.
 *
 * Mirrors executeSwapPlan: a transfers row first (kind 'nft_market', the same
 * kind the site writes, so the site's hourly marketplace cap counts chat sales
 * too and history labels them the same way), then each
 * call from the EOA or through the HybridDeleGator, waited on in order so the
 * approval lands before the accept.
 */

const { ethers } = require('ethers');
const { ensureAgentWallet, getAgentSigner } = require('../agentWallet');
const { pointerIsGator, gatorGasReserveWei, executeGatorCall } = require('../gatorExecute');
const { predictGatorAddress } = require('../gatorAccount');
const { explorerTxUrl } = require('../chains');
const { publicErrorMessage } = require('../sanitize');
const { config } = require('../config');
const { insertTransfer, logSubmitted, logReceipt } = require('../transferLog');
const { FUND_REASON, fundingWallText } = require('./fundingWall');

/**
 * @param {object} args
 * @param {object} args.plan NFT_ACCEPT_OFFER plan from lib/router.js
 * @param {import('ethers').JsonRpcProvider} args.provider
 * @param {object} args.chain
 */
async function executeAcceptOfferPlan({ plan, provider, chain }) {
  if (!plan || plan.intent !== 'NFT_ACCEPT_OFFER') return { ok: false, error: 'Not an offer plan.' };
  const accountId = plan.actor?.accountId;
  if (!accountId) return { ok: false, error: 'Not linked.' };
  const calls = plan.route?.calls || [];
  if (!calls.length) return { ok: false, error: 'Nothing to send.' };

  const transferRow = await insertTransfer({
    account_id: accountId,
    phone: plan.actor?.waSenderId || 'wa',
    to_address: plan.route.marketAddress,
    amount_eth: '0',
    status: 'pending',
    chain_id: chain.chainId,
    kind: 'nft_market',
    asset: 'ETH',
    counterparty_label: plan.input.label,
    direction: 'out',
  });
  if (!transferRow?.id) {
    console.error('executeAcceptOfferPlan: history insert failed (sale will still run)');
  }

  try {
    const account = await ensureAgentWallet(accountId);
    const viaGator = pointerIsGator(accountId, account.agent_wallet_address);
    const signer = getAgentSigner(accountId, provider);
    const walletAddr = viaGator ? predictGatorAddress(accountId) : signer.address;

    // Selling costs only gas, paid by the wallet; no paymaster on the gator path.
    const gasBuffer = viaGator
      ? (await gatorGasReserveWei(provider, walletAddr)) * BigInt(calls.length)
      : ethers.parseEther(config.gasBufferEth);
    const bal = await provider.getBalance(walletAddr);
    if (bal < gasBuffer) {
      if (transferRow?.id) await logReceipt(transferRow.id, { ok: false, txHash: '', error: 'insufficient balance for gas' });
      return { ok: false, reason: FUND_REASON, error: fundingWallText({ kind: 'native', address: walletAddr }) };
    }

    let txHash = '';
    for (const call of calls) {
      if (viaGator) {
        const res = await executeGatorCall({
          accountId,
          provider,
          chainId: chain.chainId,
          target: call.target,
          value: BigInt(call.value || 0),
          data: call.data,
        });
        txHash = res.txHash;
      } else {
        const tx = await signer.sendTransaction({ to: call.target, value: BigInt(call.value || 0), data: call.data });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) throw new Error('marketplace transaction reverted');
        txHash = tx.hash;
      }
    }

    await logSubmitted(transferRow?.id, txHash);
    await logReceipt(transferRow?.id, { ok: true, txHash });
    return { ok: true, txHash, explorerUrl: explorerTxUrl(chain, txHash) };
  } catch (err) {
    console.error('executeAcceptOfferPlan:', publicErrorMessage(err));
    if (transferRow?.id) {
      await logReceipt(transferRow.id, { ok: false, txHash: '', error: publicErrorMessage(err) });
    }
    return {
      ok: false,
      error: 'The sale did not go through. The offer may have been cancelled or changed. Nothing was sold.',
    };
  }
}

module.exports = { executeAcceptOfferPlan };
