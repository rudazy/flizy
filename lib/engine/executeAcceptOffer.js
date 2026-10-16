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
const { pointerIsGator, gatorGasReserveWei, executeGatorCall, outcomeUnknown, gatorErrorCopy } = require('../gatorExecute');
const { predictGatorAddress } = require('../gatorAccount');
const { explorerTxUrl } = require('../chains');
const { publicErrorMessage } = require('../sanitize');
const { config } = require('../config');
const { insertTransfer, logSubmitted, logReceipt, recordBroadcast } = require('../transferLog');
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

  const rowPayload = {
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
  };
  let transferRow = await insertTransfer(rowPayload);
  if (!transferRow?.id) {
    console.error('executeAcceptOfferPlan: history insert failed (sale will still run)');
  }

  let saleBroadcast = false;
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
    for (const [i, call] of calls.entries()) {
      const isSale = i === calls.length - 1;
      if (viaGator) {
        const res = await executeGatorCall({
          accountId,
          provider,
          chainId: chain.chainId,
          target: call.target,
          value: BigInt(call.value || 0),
          data: call.data,
          // Only the last call sells. Its hash is recorded before broadcast;
          // the approvals before it move nothing.
          onBroadcast: isSale
            ? async (hash) => {
                transferRow = { id: await recordBroadcast(transferRow?.id, hash, rowPayload) };
                saleBroadcast = true;
              }
            : undefined,
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
    // The sale was broadcast with no answer: it may have sold. The row stays
    // 'submitted' for the reconciler. An unconfirmed approval sold nothing.
    if (outcomeUnknown(err) && saleBroadcast) {
      return { ok: false, submitted: true, txHash: err.txHash, error: gatorErrorCopy(err) };
    }
    if (transferRow?.id) {
      await logReceipt(transferRow.id, { ok: false, txHash: err?.txHash || '', error: publicErrorMessage(err) });
    }
    const refusal = outcomeUnknown(err) ? null : gatorErrorCopy(err);
    return {
      ok: false,
      submitted: false,
      error: refusal || 'The sale did not go through. The offer may have been cancelled or changed. Nothing was sold.',
    };
  }
}

module.exports = { executeAcceptOfferPlan };
