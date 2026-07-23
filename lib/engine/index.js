/**
 * Flizy execution layer (Phase 0 foundation).
 * Intent → Policy → Plan → Execute → Receipt
 */

const { createSendIntent, createSwapIntent } = require('./intent');
const {
  evaluateSendPolicy,
  evaluateClaimHoldPolicy,
  evaluateSwapPolicy,
} = require('./policy');
const {
  buildSendPlan,
  formatPlanPreview,
  assertPlanFunded,
  buildClaimPlan,
  formatClaimPlanPreview,
  buildSwapPlan,
  formatSwapPlanPreview,
} = require('./plan');
const { executeNativeSend, executeTokenSend } = require('./executeTransfer');
const { executeClaimHold, executeClaimRefund, executeClaimPayout } = require('./executeClaim');
const { executeSwapPlan } = require('./executeSwap');
const { formatSendReceipt, formatSwapReceipt } = require('./receipt');

module.exports = {
  createSendIntent,
  createSwapIntent,
  evaluateSendPolicy,
  evaluateClaimHoldPolicy,
  evaluateSwapPolicy,
  buildSendPlan,
  formatPlanPreview,
  assertPlanFunded,
  buildClaimPlan,
  formatClaimPlanPreview,
  buildSwapPlan,
  formatSwapPlanPreview,
  executeNativeSend,
  executeTokenSend,
  executeClaimHold,
  executeClaimRefund,
  executeClaimPayout,
  executeSwapPlan,
  formatSendReceipt,
  formatSwapReceipt,
};
