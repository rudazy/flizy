/**
 * Receipt Engine — user-facing proof of what happened.
 */

const { formatClaimAmount } = require('../claimAmount');

/** Amount as the user reads it: "0.005 ETH", or "giwaforge #21" for an NFT. */
function planAmount(plan) {
  return formatClaimAmount({
    amount_eth: plan.input.amount,
    asset: plan.input.asset,
    nft_token_id: plan.route?.nftTokenId || plan.input.nftTokenId,
  });
}

/** Who the plan pays. Label first; the address only when there is no label. */
function planRecipient(plan) {
  return plan.input.recipientLabel || short(plan.input.recipientAddress);
}

/**
 * In-flight line, sent the moment a confirmed plan starts executing.
 *
 * Names the amount and the recipient rather than a bare status line, so a slow
 * network reads as "this send is still running" and not "the bot stopped
 * answering". Deliberately the same shape as the receipt that follows it.
 *
 * @param {import('./plan').ExecutionPlan} plan
 */
function formatSendPending(plan) {
  if (!plan || !plan.input) return 'Sending...';
  return `Sending ${planAmount(plan)} to ${planRecipient(plan)}...`;
}

/**
 * @param {object} result
 * @param {boolean} result.ok
 * @param {string} [result.txHash]
 * @param {string} [result.explorerUrl]
 * @param {string} [result.error]
 * @param {import('./plan').ExecutionPlan} [plan]
 */
function formatSendReceipt(result, plan) {
  if (!result.ok) {
    return result.error || 'Transfer failed.';
  }

  const lines = ['Sent.'];
  if (plan && plan.input) {
    lines.push(`${planAmount(plan)} → ${planRecipient(plan)}`);
    lines.push(`Chain: ${plan.route.chainName}`);
  }
  if (result.explorerUrl) {
    lines.push('', result.explorerUrl);
  } else if (result.txHash) {
    lines.push('', result.txHash);
  }
  return lines.join('\n');
}

function short(addr) {
  const s = String(addr || '');
  if (s.length < 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

/**
 * Two-phase style: after receipt lands, claim success.
 * @param {object} result
 * @param {object} [plan]
 */
function formatSwapReceipt(result, plan) {
  if (!result.ok) {
    return result.error || 'Swap failed.';
  }
  const lines = ['Swap confirmed.'];
  if (plan) {
    lines.push(
      `${plan.input.amount} ${plan.input.tokenInLabel} → ~${plan.input.amountOut} ${plan.input.tokenOutLabel}`
    );
    lines.push(`Fee: ${plan.input.feePct} (~${plan.input.fee} ${plan.input.tokenInLabel})`);
    lines.push(`Chain: ${plan.route.chainName}`);
  }
  if (result.explorerUrl) {
    lines.push('', result.explorerUrl);
  } else if (result.txHash) {
    lines.push('', result.txHash);
  }
  lines.push('', 'Check: flizy balance');
  return lines.join('\n');
}

module.exports = {
  formatSendPending,
  formatSendReceipt,
  formatSwapReceipt,
};
