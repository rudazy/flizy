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
  beginClaimProcessing,
  releaseClaimProcessing,
  cancelClaim,
  markClaimed,
  getClaimById,
  normalizeWaHint,
} = require('../claims');
const { normalizePhoneNumber, isPlausiblePhone } = require('../phone');
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

  // Same guard as payout, and it also settles the cross race: a sender
  // cancelling while the recipient claims can no longer have escrow pay both.
  const held = await beginClaimProcessing(claimId);
  if (!held) {
    return { ok: false, error: 'That claim is already being processed.' };
  }

  let submitted = false;

  try {
    const escBal = await provider.getBalance(escrow.address);
    const gasBuffer = ethers.parseEther(config.gasBufferEth);
    if (escBal < amountWei + gasBuffer) {
      await releaseClaimProcessing(claimId);
      return {
        ok: false,
        error: 'Escrow cannot refund right now (insufficient hold balance). Try later.',
      };
    }

    const tx = await escrow.sendTransaction({
      to: agent.address,
      value: amountWei,
    });
    submitted = true;

    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      await releaseClaimProcessing(claimId);
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
    if (!submitted) {
      try {
        await releaseClaimProcessing(claimId);
      } catch (releaseErr) {
        console.error('executeClaimRefund release:', publicErrorMessage(releaseErr));
      }
      return { ok: false, error: 'Refund failed. Try again shortly.' };
    }
    console.error(
      `[claim] ${claimId} left in processing after a submitted refund. Check escrow ${escrow.address} on-chain before releasing it.`
    );
    return {
      ok: false,
      error: 'Refund was sent but could not be confirmed. Check your balance before retrying.',
    };
  }
}

/**
 * Payout pending claim to recipient.
 * Claim is addressed by phone (to_wa_hint). Match on recipient phone, not LID.
 *
 * @param {string} [toWaPhone]  normalized phone from identity / WA context (preferred)
 * @param {string} [toWaSender]  LID or legacy sender id (fallback only if no phone)
 */
async function executeClaimPayout({
  claimId,
  toAccountId,
  toWaSender,
  toWaPhone,
  provider,
  chain,
  escrowWallet,
}) {
  const claim = await getClaimById(claimId);
  if (!claim) return { ok: false, error: 'Claim not found.' };
  if (claim.status !== 'pending') {
    return { ok: false, error: `Claim is already ${claim.status}.` };
  }
  const hint = normalizePhoneNumber(claim.to_wa_hint);
  const phone = toWaPhone ? normalizePhoneNumber(toWaPhone) : '';
  const matchKey =
    phone && isPlausiblePhone(phone)
      ? phone
      : toWaSender
        ? normalizePhoneNumber(toWaSender)
        : '';
  if (!matchKey || hint !== matchKey) {
    return {
      ok: false,
      error: phone
        ? 'This claim is for a different WhatsApp number.'
        : 'Could not verify your phone for this claim. Message the bot again, or re-link WhatsApp.',
    };
  }

  const amountWei = ethers.parseEther(String(claim.amount_eth));
  await ensureAgentWallet(toAccountId);
  const agent = getAgentSigner(toAccountId, provider);
  const escrow = resolveEscrow(provider, escrowWallet);

  // Take the row before touching the chain. Everything above this line is a
  // cheap rejection that must not lock a claim the caller was never entitled to.
  const held = await beginClaimProcessing(claimId);
  if (!held) {
    return { ok: false, error: 'That claim is already being processed.' };
  }

  // Flips the instant sendTransaction resolves. After that point a rollback to
  // 'pending' would make the claim payable again while the first transfer may
  // still confirm, which is the double send this guard exists to prevent.
  let submitted = false;

  try {
    const escBal = await provider.getBalance(escrow.address);
    const gasBuffer = ethers.parseEther(config.gasBufferEth);
    if (escBal < amountWei + gasBuffer) {
      await releaseClaimProcessing(claimId);
      return {
        ok: false,
        error: 'Payout temporarily unavailable (escrow). Try again later.',
      };
    }

    const tx = await escrow.sendTransaction({
      to: agent.address,
      value: amountWei,
    });
    submitted = true;

    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      // Mined and reverted, so no value moved. Safe to make it claimable again.
      await releaseClaimProcessing(claimId);
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
    if (!submitted) {
      try {
        await releaseClaimProcessing(claimId);
      } catch (releaseErr) {
        console.error('executeClaimPayout release:', publicErrorMessage(releaseErr));
      }
      return { ok: false, error: 'Payout failed. Try again shortly.' };
    }
    // Submitted but the outcome is unknown. Leave it in 'processing' on purpose:
    // a human checks the chain rather than the code guessing and paying twice.
    console.error(
      `[claim] ${claimId} left in processing after a submitted payout. Check escrow ${escrow.address} on-chain before releasing it.`
    );
    return {
      ok: false,
      error: 'Payout was sent but could not be confirmed. Check your balance before retrying.',
    };
  }
}

module.exports = {
  executeClaimHold,
  executeClaimRefund,
  executeClaimPayout,
};
