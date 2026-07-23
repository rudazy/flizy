/**
 * Execution Plan — every money move is planned before it runs.
 * Plans are what users confirm; engines execute only approved plans.
 */

const { ethers } = require('ethers');
const { config } = require('../config');

/**
 * @typedef {object} ExecutionPlan
 * @property {string} id
 * @property {string} intent
 * @property {object} input
 * @property {string[]} steps
 * @property {object} estimated
 * @property {boolean} requiresConfirmation
 * @property {string} policyDecision
 * @property {object} [policyChecks]
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {object} actor
 * @property {object} route
 */

/**
 * Build a native ETH send plan after policy ALLOW*.
 *
 * @param {object} args
 * @param {import('./intent').SendIntent} args.intent
 * @param {import('./policy').PolicyResult} args.policy
 * @param {{ chainId: number, chainName: string, nativeSymbol: string }} args.chain
 * @param {string} args.fromAddress
 * @param {string} [args.fromBalanceEth]
 * @param {string} [args.gasBufferEth]
 * @returns {ExecutionPlan}
 */
function buildSendPlan({
  intent,
  policy,
  chain,
  fromAddress,
  fromBalanceEth,
  gasBufferEth = config.gasBufferEth,
}) {
  const label = intent.toLabel || null;
  const to = intent.toAddress;
  const amountEth = intent.amountEth;

  const steps = [
    `Check agent wallet balance on ${chain.chainName}`,
    `Transfer ${amountEth} ${chain.nativeSymbol} to ${label || shortAddr(to)}`,
    'Wait for network confirmation',
    'Write receipt (explorer + history)',
  ];

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    intent: 'SEND',
    input: {
      amount: amountEth,
      asset: chain.nativeSymbol,
      currency: chain.nativeSymbol,
      recipient: label || to,
      recipientAddress: to,
      recipientLabel: label,
    },
    steps,
    estimated: {
      amountEth,
      gasBufferEth,
      fromBalanceEth: fromBalanceEth ?? null,
      fees: 'network gas (paid from agent wallet)',
    },
    requiresConfirmation: true,
    policyDecision: policy.decision,
    policyChecks: policy.checks || {},
    createdAt: Date.now(),
    expiresAt: Date.now() + config.pendingTtlMs,
    actor: {
      accountId: intent.actor.accountId,
      userId: intent.actor.userId || null,
      waSenderId: intent.actor.waSenderId,
    },
    route: {
      kind: 'native_transfer',
      chainId: chain.chainId,
      chainName: chain.chainName,
      fromAddress,
      toAddress: to,
    },
  };
}

/**
 * WhatsApp / human-readable preview of a plan.
 * @param {ExecutionPlan} plan
 */
function formatPlanPreview(plan) {
  const mins = Math.max(1, Math.round((plan.expiresAt - plan.createdAt) / 60000));
  const toLine = plan.input.recipientLabel
    ? `${plan.input.recipientLabel} (${shortAddr(plan.input.recipientAddress)})`
    : shortAddr(plan.input.recipientAddress);

  const lines = [
    'Transfer plan',
    '',
    `Amount:  ${plan.input.amount} ${plan.input.asset}`,
    `To:      ${toLine}`,
    `From:    ${shortAddr(plan.route.fromAddress)} (your agent wallet)`,
    `Chain:   ${plan.route.chainName}`,
    '',
    'Steps',
    ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    `Reply confirm within ${mins} minutes to execute.`,
    'Or: cancel',
  ];
  return lines.join('\n');
}

/**
 * @param {ExecutionPlan} plan
 * @param {string} fromBalanceEth
 * @param {string} [gasBufferEth]
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function assertPlanFunded(plan, fromBalanceEth, gasBufferEth = config.gasBufferEth) {
  try {
    const need = ethers.parseEther(String(plan.input.amount)) + ethers.parseEther(String(gasBufferEth));
    const have = ethers.parseEther(String(fromBalanceEth));
    if (have < need) {
      return {
        ok: false,
        message: [
          'Not enough ETH in your agent wallet (amount + gas).',
          `Have ${trimEth(fromBalanceEth)} ETH`,
          `Need ~${plan.input.amount} ETH + gas`,
          `Fund: ${plan.route.fromAddress}`,
        ].join('\n'),
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: 'Could not verify wallet balance. Try again shortly.' };
  }
}

function shortAddr(addr) {
  try {
    const a = ethers.getAddress(addr);
    return `${a.slice(0, 6)}...${a.slice(-4)}`;
  } catch {
    const s = String(addr || '');
    if (s.length < 12) return s;
    return `${s.slice(0, 6)}...${s.slice(-4)}`;
  }
}

function trimEth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  return n.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Plan for hold-to-phone claim (escrow until recipient links WhatsApp).
 */
function buildClaimPlan({
  intent,
  policy,
  chain,
  fromAddress,
  toWaHint,
  fromBalanceEth,
  gasBufferEth = config.gasBufferEth,
}) {
  const amountEth = intent.amountEth;
  const steps = [
    `Hold ${amountEth} ${chain.nativeSymbol} from your agent wallet`,
    `Reserve for WhatsApp +${toWaHint} (pending claim)`,
    'They only receive after that WhatsApp links Flizy',
    'You can cancel anytime: flizy cancel claims',
  ];

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    intent: 'CLAIM_HOLD',
    input: {
      amount: amountEth,
      asset: chain.nativeSymbol,
      currency: chain.nativeSymbol,
      recipient: `+${toWaHint}`,
      recipientAddress: null,
      recipientLabel: `+${toWaHint}`,
      toWaHint,
    },
    steps,
    estimated: {
      amountEth,
      gasBufferEth,
      fromBalanceEth: fromBalanceEth ?? null,
      fees: 'network gas (paid from agent wallet)',
    },
    requiresConfirmation: true,
    policyDecision: policy?.decision || 'ALLOW_WITH_CONFIRM',
    policyChecks: policy?.checks || {},
    createdAt: Date.now(),
    expiresAt: Date.now() + config.pendingTtlMs,
    actor: {
      accountId: intent.actor.accountId,
      userId: intent.actor.userId || null,
      waSenderId: intent.actor.waSenderId,
    },
    route: {
      kind: 'claim_hold',
      chainId: chain.chainId,
      chainName: chain.chainName,
      fromAddress,
      toWaHint,
    },
  };
}

function formatClaimPlanPreview(plan) {
  const mins = Math.max(1, Math.round((plan.expiresAt - plan.createdAt) / 60000));
  return [
    'Claim plan (hold for phone)',
    '',
    `Amount:  ${plan.input.amount} ${plan.input.asset}`,
    `For:     ${plan.input.recipient} (not on Flizy yet or not linked)`,
    `From:    ${shortAddr(plan.route.fromAddress)} (your agent wallet)`,
    `Chain:   ${plan.route.chainName}`,
    '',
    'They only see/receive this after that WhatsApp links Flizy.',
    'You can cancel anytime while pending:',
    '  flizy cancel claims',
    '',
    'Steps',
    ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    `Reply confirm within ${mins} minutes to hold funds.`,
    'Or: cancel',
  ].join('\n');
}

/**
 * Swap plan. Fee line is mandatory (protocol fee disclosure).
 *
 * @param {object} args
 * @param {object} args.intent
 * @param {object} args.policy
 * @param {object} args.chain
 * @param {string} args.fromAddress
 * @param {string} args.amountInDisplay
 * @param {string} args.amountOutDisplay
 * @param {string} args.feeDisplay
 * @param {string} args.feePctDisplay
 * @param {string} args.slippagePctDisplay
 * @param {string} args.tokenInLabel
 * @param {string} args.tokenOutLabel
 * @param {string} args.routerAddress
 * @param {string} args.amountInWei
 * @param {string} args.amountOutMinWei
 * @param {boolean} args.inIsNative
 * @param {boolean} args.outIsNative
 * @param {string|null} args.tokenIn
 * @param {string|null} args.tokenOut
 */
function buildSwapPlan({
  intent,
  policy,
  chain,
  fromAddress,
  amountInDisplay,
  amountOutDisplay,
  feeDisplay,
  feePctDisplay,
  slippagePctDisplay,
  tokenInLabel,
  tokenOutLabel,
  routerAddress,
  amountInWei,
  amountOutMinWei,
  inIsNative,
  outIsNative,
  tokenIn,
  tokenOut,
}) {
  const steps = [
    `Swap ${amountInDisplay} ${tokenInLabel} for ~${amountOutDisplay} ${tokenOutLabel}`,
    `Protocol fee ${feePctDisplay} (~${feeDisplay} ${tokenInLabel}) to Flizy treasury`,
    `Slippage tolerance ${slippagePctDisplay}`,
    'Wait for network confirmation',
    'Write receipt (explorer + balances)',
  ];

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    intent: 'SWAP',
    input: {
      amount: amountInDisplay,
      asset: tokenInLabel,
      tokenInLabel,
      tokenOutLabel,
      amountOut: amountOutDisplay,
      fee: feeDisplay,
      feePct: feePctDisplay,
      slippagePct: slippagePctDisplay,
      amountInWei: String(amountInWei),
      amountOutMinWei: String(amountOutMinWei),
      inIsNative: Boolean(inIsNative),
      outIsNative: Boolean(outIsNative),
      tokenIn: tokenIn || null,
      tokenOut: tokenOut || null,
    },
    steps,
    estimated: {
      amountIn: amountInDisplay,
      amountOut: amountOutDisplay,
      fee: feeDisplay,
      feePct: feePctDisplay,
      slippagePct: slippagePctDisplay,
      fees: `protocol ${feePctDisplay} + network gas`,
    },
    requiresConfirmation: true,
    policyDecision: policy?.decision || 'ALLOW_WITH_CONFIRM',
    policyChecks: policy?.checks || {},
    createdAt: Date.now(),
    expiresAt: Date.now() + config.pendingTtlMs,
    actor: {
      accountId: intent.actor.accountId,
      userId: intent.actor.userId || null,
      waSenderId: intent.actor.waSenderId,
    },
    route: {
      kind: 'swap',
      chainId: chain.chainId,
      chainName: chain.chainName,
      fromAddress,
      routerAddress,
    },
  };
}

function formatSwapPlanPreview(plan) {
  const mins = Math.max(1, Math.round((plan.expiresAt - plan.createdAt) / 60000));
  return [
    'Swap plan',
    '',
    `You pay:    ${plan.input.amount} ${plan.input.tokenInLabel}`,
    `You get:    ~${plan.input.amountOut} ${plan.input.tokenOutLabel}`,
    `Fee:        ${plan.input.feePct} (~${plan.input.fee} ${plan.input.tokenInLabel})`,
    `Slippage:   ${plan.input.slippagePct}`,
    `From:       ${shortAddr(plan.route.fromAddress)} (agent wallet)`,
    `Chain:      ${plan.route.chainName}`,
    `Router:     ${shortAddr(plan.route.routerAddress)}`,
    '',
    'Steps',
    ...plan.steps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    `Reply confirm within ${mins} minutes to execute.`,
    'Or: cancel',
  ].join('\n');
}

module.exports = {
  buildSendPlan,
  formatPlanPreview,
  assertPlanFunded,
  buildClaimPlan,
  formatClaimPlanPreview,
  buildSwapPlan,
  formatSwapPlanPreview,
};
