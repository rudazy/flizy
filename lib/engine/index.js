/**
 * Flizy execution layer (Phase 0 foundation).
 * Intent → Policy → Plan → Execute → Receipt
 */

const { createSendIntent } = require('./intent');
const { evaluateSendPolicy } = require('./policy');
const {
  buildSendPlan,
  formatPlanPreview,
  assertPlanFunded,
  buildClaimPlan,
  formatClaimPlanPreview,
} = require('./plan');
const { executeNativeSend } = require('./executeTransfer');
const { executeClaimHold, executeClaimRefund, executeClaimPayout } = require('./executeClaim');
const { formatSendReceipt } = require('./receipt');

module.exports = {
  createSendIntent,
  evaluateSendPolicy,
  buildSendPlan,
  formatPlanPreview,
  assertPlanFunded,
  buildClaimPlan,
  formatClaimPlanPreview,
  executeNativeSend,
  executeClaimHold,
  executeClaimRefund,
  executeClaimPayout,
  formatSendReceipt,
};
