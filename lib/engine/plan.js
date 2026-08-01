/**
 * Execution Plan — every money move is planned before it runs.
 * Plans are what users confirm; engines execute only approved plans.
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const {
  phoneRecipient,
  claimRecipientLabel,
  channelLabel,
} = require('../claimRecipient');

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
  tokenAddress = null,
  tokenSymbol = null,
  tokenBalance = null,
}) {
  const label = intent.toLabel || null;
  const to = intent.toAddress;
  const amountEth = intent.amountEth;
  const isToken = Boolean(tokenAddress);
  const asset = isToken
    ? String(tokenSymbol || intent.asset || 'TOKEN').toUpperCase()
    : chain.nativeSymbol || 'ETH';

  const steps = [
    `Check agent wallet balance on ${chain.chainName}`,
    `Transfer ${amountEth} ${asset} to ${label || shortAddr(to)}`,
    'Wait for network confirmation',
    'Write receipt (explorer + history)',
  ];

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    intent: 'SEND',
    input: {
      amount: amountEth,
      asset,
      currency: asset,
      recipient: label || to,
      recipientAddress: to,
      recipientLabel: label,
      tokenAddress: tokenAddress || null,
      tokenSymbol: isToken ? asset : null,
    },
    steps,
    estimated: {
      amountEth: isToken ? null : amountEth,
      amount: amountEth,
      asset,
      gasBufferEth,
      fromBalanceEth: fromBalanceEth ?? null,
      tokenBalance: tokenBalance ?? null,
      fees: 'network gas (paid from agent wallet in ETH)',
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
      kind: isToken ? 'erc20_transfer' : 'native_transfer',
      chainId: chain.chainId,
      chainName: chain.chainName,
      fromAddress,
      toAddress: to,
      tokenAddress: tokenAddress || null,
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

  // Every other send in the product goes to an address the user put on their
  // own trusted list. Paying a payment request is the one that does not, so the
  // screen says which kind this is rather than looking identical to the other.
  const trustedSkipped = plan.policyChecks?.trustedEnforced === false;

  const lines = [
    'Transfer plan',
    '',
    `Amount:  ${plan.input.amount} ${plan.input.asset}`,
    `To:      ${toLine}`,
    ...(trustedSkipped
      ? ['         Not on your trusted list. Only confirm if you know them.']
      : []),
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
 * @param {{ tokenBalance?: string|null }} [opts]
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function assertPlanFunded(plan, fromBalanceEth, gasBufferEth = config.gasBufferEth, opts = {}) {
  try {
    const isToken = plan.route?.kind === 'erc20_transfer';
    const gasWei = ethers.parseEther(String(gasBufferEth));
    const haveEth = ethers.parseEther(String(fromBalanceEth));

    if (isToken) {
      if (haveEth < gasWei) {
        return {
          ok: false,
          message: [
            'Need a little ETH in your agent wallet for gas.',
            `Fund: ${plan.route.fromAddress}`,
          ].join('\n'),
        };
      }
      const tokBal = opts.tokenBalance ?? plan.estimated?.tokenBalance;
      if (tokBal != null) {
        const need = ethers.parseEther(String(plan.input.amount));
        const have = ethers.parseEther(String(tokBal));
        if (have < need) {
          const sym = plan.input.asset || 'TOKEN';
          return {
            ok: false,
            message: [
              `Not enough ${sym} in your agent wallet.`,
              `Have ${trimEth(tokBal)} ${sym}`,
              `Need ${plan.input.amount} ${sym}`,
              `Fund: ${plan.route.fromAddress}`,
            ].join('\n'),
          };
        }
      }
      return { ok: true };
    }

    const need = ethers.parseEther(String(plan.input.amount)) + gasWei;
    if (haveEth < need) {
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
 * Plan for a claim hold (escrow until the recipient proves who they are).
 *
 * Pass either toWaHint (phone, as before) or a recipient from
 * lib/claimRecipient. The copy follows whichever way the claim is addressed:
 * a phone claim still says WhatsApp, a platform claim names the platform.
 */
function buildClaimPlan({
  intent,
  policy,
  chain,
  fromAddress,
  toWaHint,
  recipient,
  fromBalanceEth,
  gasBufferEth = config.gasBufferEth,
}) {
  const amountEth = intent.amountEth;
  const to = recipient || phoneRecipient(toWaHint);
  const label = claimRecipientLabel(to);
  const isPhone = to.kind === 'phone';
  const where = isPhone ? 'WhatsApp' : channelLabel(to.channel);

  const steps = [
    `Hold ${amountEth} ${chain.nativeSymbol} from your agent wallet`,
    `Reserve for ${label} (pending claim)`,
    isPhone
      ? 'They only receive after that WhatsApp links Flizy'
      : `They only receive after they sign in with ${where} and link Flizy`,
    'You can cancel anytime: flizy cancel claims',
  ];

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    intent: 'CLAIM_HOLD',
    input: {
      amount: amountEth,
      asset: chain.nativeSymbol,
      currency: chain.nativeSymbol,
      recipient: label,
      recipientAddress: null,
      recipientLabel: label,
      recipientKind: to.kind,
      recipientChannel: isPhone ? null : to.channel,
      toWaHint: isPhone ? to.phone : null,
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
      toWaHint: isPhone ? to.phone : null,
      recipient: to,
    },
  };
}

function formatClaimPlanPreview(plan) {
  const mins = Math.max(1, Math.round((plan.expiresAt - plan.createdAt) / 60000));
  const isPhone = plan.input.recipientKind !== 'platform';
  const where = isPhone ? 'WhatsApp' : channelLabel(plan.input.recipientChannel);

  return [
    isPhone ? 'Claim plan (hold for phone)' : `Claim plan (hold for ${plan.input.recipient})`,
    '',
    `Amount:  ${plan.input.amount} ${plan.input.asset}`,
    `For:     ${plan.input.recipient} (not on Flizy yet or not linked)`,
    `From:    ${shortAddr(plan.route.fromAddress)} (your agent wallet)`,
    `Chain:   ${plan.route.chainName}`,
    '',
    isPhone
      ? 'They only see/receive this after that WhatsApp links Flizy.'
      : `They only see/receive this after they sign in with ${where} and link Flizy.`,
    ...(isPhone
      ? []
      : ['Check the handle carefully. A lookalike handle is a different person.']),
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
    `Protocol fee: ${plan.input.feePct} (~${plan.input.fee} ${plan.input.tokenInLabel})`,
    'Pool fee:    ~0.30% (Uniswap V2 style)',
    'All-in:      ~0.60% + network gas',
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
