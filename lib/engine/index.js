/**
 * Flizy execution layer (Phase 0 foundation).
 * Intent → Policy → Plan → Execute → Receipt
 */

const { createSendIntent } = require('./intent');
const { evaluateSendPolicy } = require('./policy');
const { buildSendPlan, formatPlanPreview, assertPlanFunded } = require('./plan');
const { executeNativeSend } = require('./executeTransfer');
const { formatSendReceipt } = require('./receipt');

module.exports = {
  createSendIntent,
  evaluateSendPolicy,
  buildSendPlan,
  formatPlanPreview,
  assertPlanFunded,
  executeNativeSend,
  formatSendReceipt,
};
