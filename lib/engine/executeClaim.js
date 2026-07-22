/**
 * Claim escrow execution via dedicated escrow wallet (not ops gas key).
 * Hold: sender agent → escrow
 * Refund (cancel): escrow → sender agent
 * Payout (after WA link): escrow → recipient agent
 *
 * Invariant: escrow balance >= sum(pending claim amounts) [+ gas buffer for next payout].
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
const { getEscrowWallet, assertEscrowSolvent } = require('../escrowWallet');
const { publicErrorMessage } = require('../sanitize');
const { explorerTxUrl } = require('../chains');

function resolveEscrow(provider, escrowWallet) {
  return escrowWallet || getEscrowWallet(provider);
}

/**
 * Escrow amount from sender agent wallet into claim escrow, then create pending claim.
 */
async function executeClaimHold({
  fromAccountId,
  fromWaSender,
  toWaHint,
  amountEth,
  provider,
  chain,
  escrowWallet,
}) {
  const amountWei = ethers.parseEther(String(amountEth));
  if (amountWei <= 0n) {
    return { ok: false, error: 'Amount must be greater than 0.' };
  }

  const escrow = resolveEscrow(provider, escrowWallet);

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
      to: escrow.address,
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

    // Post-hold solvency: balance should cover all pending liability
    const health = await assertEscrowSolvent(provider);
    if (!health.ok) {
      console.error(
        `[escrow] INSOLVENT after hold: balance=${health.balanceEth} liability=${health.liabilityEth}`
      );
    } else {
      console.log(
        `[escrow] hold ok liability=${health.liabilityEth} balance=${health.balanceEth} n=${health.pendingCount}`
      );
    }

    return {
      ok: true,
      claim,
      claimUrl,
      holdTxHash: tx.hash,
      explorerUrl: explorerTxUrl(chain, tx.hash),
      escrowAddress: escrow.address,
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
 * Refund one pending claim to sender from escrow.
 */
async function executeClaimRefund({ claimId, fromAccountId, provider, chain, escrowWallet }) {
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
  const escrow = resolveEscrow(provider, escrowWallet);

  try {
    const escBal = await provider.getBalance(escrow.address);
    const gasBuffer = ethers.parseEther(config.gasBufferEth);
    if (escBal < amountWei + gasBuffer) {
      return {
        ok: false,
        error: 'Escrow cannot refund right now (insufficient hold balance). Try later.',
      };
    }

    const tx = await escrow.sendTransaction({
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
 * Payout pending claim to recipient (WA must match claim hint).
 */
async function executeClaimPayout({
  claimId,
  toAccountId,
  toWaSender,
  provider,
  chain,
  escrowWallet,
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
  const escrow = resolveEscrow(provider, escrowWallet);

  try {
    const escBal = await provider.getBalance(escrow.address);
    const gasBuffer = ethers.parseEther(config.gasBufferEth);
    if (escBal < amountWei + gasBuffer) {
      return {
        ok: false,
        error: 'Payout temporarily unavailable (escrow). Try again later.',
      };
    }

    const tx = await escrow.sendTransaction({
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
