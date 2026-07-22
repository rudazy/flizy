/**
 * Claim escrow execution via ops wallet hold.
 * Hold: sender agent → ops
 * Refund (cancel): ops → sender agent
 * Payout (after WA link): ops → recipient agent
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const {
  createClaim,
  cancelClaim,
  markClaimed,
  getClaimById,
  normalizeWaHint,
} = require('../claims');
const { ensureAgentWallet, getAgentSigner } = require('../agentWallet');
const { publicErrorMessage } = require('../sanitize');
const { explorerTxUrl } = require('../chains');

/**
 * Escrow amount from sender agent wallet into ops, then create pending claim.
 *
 * @param {object} args
 * @param {string} args.fromAccountId
 * @param {string} args.fromWaSender
 * @param {string} args.toWaHint
 * @param {string} args.amountEth
 * @param {import('ethers').Provider} args.provider
 * @param {import('../chains').ChainConfig} args.chain
 * @param {import('ethers').Wallet} args.opsWallet connected
 */
async function executeClaimHold({
  fromAccountId,
  fromWaSender,
  toWaHint,
  amountEth,
  provider,
  chain,
  opsWallet,
}) {
  const amountWei = ethers.parseEther(String(amountEth));
  if (amountWei <= 0n) {
    return { ok: false, error: 'Amount must be greater than 0.' };
  }

  await ensureAgentWallet(fromAccountId);
  const agent = getAgentSigner(fromAccountId, provider);
  const gasBuffer = ethers.parseEther(config.gasBufferEth);
  const bal = await provider.getBalance(agent.address);
  if (bal < amountWei + gasBuffer) {
    return {
      ok: false,
      error: [
        'Not enough ETH in your agent wallet (amount + gas).',
        `Fund: ${agent.address}`,
      ].join('\n'),
    };
  }

  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== chain.chainId) {
      throw new Error(`Wrong chain id ${network.chainId}, expected ${chain.chainId}`);
    }

    const tx = await agent.sendTransaction({
      to: opsWallet.address,
      value: amountWei,
    });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      return { ok: false, error: 'Escrow transaction failed on-chain.' };
    }

    const { claim, claimUrl } = await createClaim({
      fromAccountId,
      fromWaSender,
      toWaHint: normalizeWaHint(toWaHint),
      amountEth,
      chainId: chain.chainId,
      holdTxHash: tx.hash,
    });

    return {
      ok: true,
      claim,
      claimUrl,
      holdTxHash: tx.hash,
      explorerUrl: explorerTxUrl(chain, tx.hash),
    };
  } catch (err) {
    console.error('executeClaimHold:', publicErrorMessage(err));
    return {
      ok: false,
      error: 'Could not hold funds for claim. Try again shortly.',
    };
  }
}

/**
 * Refund one pending claim to sender.
 */
async function executeClaimRefund({ claimId, fromAccountId, provider, chain, opsWallet }) {
  const claim = await getClaimById(claimId);
  if (!claim) return { ok: false, error: 'Claim not found.' };
  if (claim.from_account_id !== fromAccountId) {
    return { ok: false, error: 'That claim is not yours.' };
  }
  if (claim.status !== 'pending') {
    return { ok: false, error: `Claim is already ${claim.status}.` };
  }

  const amountWei = ethers.parseEther(String(claim.amount_eth));
  await ensureAgentWallet(fromAccountId);
  const agent = getAgentSigner(fromAccountId, provider);

  try {
    const opsBal = await provider.getBalance(opsWallet.address);
    const gasBuffer = ethers.parseEther(config.gasBufferEth);
    if (opsBal < amountWei + gasBuffer) {
      return {
        ok: false,
        error: 'Ops hold cannot refund right now. Contact support or try later.',
      };
    }

    const tx = await opsWallet.sendTransaction({
      to: agent.address,
      value: amountWei,
    });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      return { ok: false, error: 'Refund transaction failed.' };
    }

    const cancelled = await cancelClaim(claimId, fromAccountId, tx.hash);
    if (!cancelled.ok) {
      return {
        ok: false,
        error: 'Refund sent but claim status update failed. Save this tx: ' + tx.hash,
        refundTxHash: tx.hash,
      };
    }

    return {
      ok: true,
      claim: cancelled.claim,
      refundTxHash: tx.hash,
      explorerUrl: explorerTxUrl(chain, tx.hash),
    };
  } catch (err) {
    console.error('executeClaimRefund:', publicErrorMessage(err));
    return { ok: false, error: 'Refund failed. Try again shortly.' };
  }
}

/**
 * Payout pending claim to recipient account (must already have linked matching WA).
 */
async function executeClaimPayout({
  claimId,
  toAccountId,
  toWaSender,
  provider,
  chain,
  opsWallet,
}) {
  const claim = await getClaimById(claimId);
  if (!claim) return { ok: false, error: 'Claim not found.' };
  if (claim.status !== 'pending') {
    return { ok: false, error: `Claim is already ${claim.status}.` };
  }
  const hint = normalizeWaHint(claim.to_wa_hint);
  const sid = normalizeWaHint(toWaSender);
  if (hint !== sid) {
    return {
      ok: false,
      error: 'This claim is for a different WhatsApp number.',
    };
  }

  const amountWei = ethers.parseEther(String(claim.amount_eth));
  await ensureAgentWallet(toAccountId);
  const agent = getAgentSigner(toAccountId, provider);

  try {
    const opsBal = await provider.getBalance(opsWallet.address);
    const gasBuffer = ethers.parseEther(config.gasBufferEth);
    if (opsBal < amountWei + gasBuffer) {
      return {
        ok: false,
        error: 'Payout temporarily unavailable. Try again later.',
      };
    }

    const tx = await opsWallet.sendTransaction({
      to: agent.address,
      value: amountWei,
    });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      return { ok: false, error: 'Payout transaction failed.' };
    }

    const updated = await markClaimed(claimId, toAccountId, tx.hash);
    return {
      ok: true,
      claim: updated,
      claimTxHash: tx.hash,
      explorerUrl: explorerTxUrl(chain, tx.hash),
    };
  } catch (err) {
    console.error('executeClaimPayout:', publicErrorMessage(err));
    return { ok: false, error: 'Payout failed. Try again shortly.' };
  }
}

module.exports = {
  executeClaimHold,
  executeClaimRefund,
  executeClaimPayout,
};
