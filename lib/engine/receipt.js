/**
 * Receipt Engine — user-facing proof of what happened.
 */

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
  if (plan) {
    lines.push(
      `${plan.input.amount} ${plan.input.asset} → ${
        plan.input.recipientLabel || short(plan.input.recipientAddress)
      }`
    );
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

module.exports = {
  formatSendReceipt,
};
