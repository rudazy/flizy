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
const { formatClaimAmount } = require('../claimAmount');

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
  reason = null,
  firstPay = false,
  offerSave = false,
  nftTokenId = null,
}) {
  const label = intent.toLabel || null;
  const to = intent.toAddress;
  const amountEth = intent.amountEth;
  const isNft = Boolean(nftTokenId);
  const isToken = Boolean(tokenAddress) && !isNft;
  const asset = isNft || isToken
    ? String(tokenSymbol || intent.asset || 'TOKEN').toUpperCase()
    : chain.nativeSymbol || 'ETH';
  const amountLine = formatClaimAmount({
    amount_eth: amountEth,
    asset,
    nft_token_id: nftTokenId,
  });

  const steps = [
    `Check agent wallet balance on ${chain.chainName}`,
    `Transfer ${amountLine} to ${label || shortAddr(to)}`,
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
      reason: reason ? String(reason).trim() : null,
      firstPay: Boolean(firstPay),
      offerSave: Boolean(offerSave),
      tokenAddress: tokenAddress || null,
      tokenSymbol: isToken || isNft ? asset : null,
      nftTokenId: nftTokenId || null,
    },
    steps,
    estimated: {
      amountEth: isToken || isNft ? null : amountEth,
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
      kind: isNft ? 'erc721_transfer' : isToken ? 'erc20_transfer' : 'native_transfer',
      chainId: chain.chainId,
      chainName: chain.chainName,
      fromAddress,
      toAddress: to,
      tokenAddress: tokenAddress || null,
      nftTokenId: nftTokenId || null,
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
    `Amount:  ${formatClaimAmount({
      amount_eth: plan.input.amount,
      asset: plan.input.asset,
      nft_token_id: plan.route?.nftTokenId || plan.input.nftTokenId,
    })}`,
    `To:      ${toLine}`,
    ...(plan.input.reason ? [`For:     ${plan.input.reason}`] : []),
    ...(plan.input.firstPay
      ? ['', 'First payment. You have not paid this person before.']
      : []),
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
    const isNft = Boolean(plan.route?.nftTokenId) || plan.route?.kind === 'erc721_transfer';
    const isToken =
      !isNft &&
      (plan.route?.kind === 'erc20_transfer' ||
        (plan.route?.kind === 'claim_hold' && Boolean(plan.route?.tokenAddress)));
    const gasWei = ethers.parseEther(String(gasBufferEth));
    const haveEth = ethers.parseEther(String(fromBalanceEth));

    if (isNft) {
      if (haveEth < gasWei) {
        return {
          ok: false,
          message: [
            'Need a little ETH in your agent wallet for gas.',
            `Fund: ${plan.route.fromAddress}`,
          ].join('\n'),
        };
      }
      if (opts.nftOwned === false) {
        const line = formatClaimAmount({
          amount_eth: plan.input.amount,
          asset: plan.input.asset,
          nft_token_id: plan.route?.nftTokenId || plan.input.nftTokenId,
        });
        return {
          ok: false,
          message: [
            `You do not hold ${line}.`,
            `Fund: ${plan.route.fromAddress}`,
          ].join('\n'),
        };
      }
      return { ok: true };
    }

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
  tokenAddress = null,
  tokenSymbol = null,
  tokenBalance = null,
  nftTokenId = null,
}) {
  const amountEth = intent.amountEth;
  const to = recipient || phoneRecipient(toWaHint);
  const label = claimRecipientLabel(to);
  const isPhone = to.kind === 'phone';
  const isEmail = to.kind === 'email';
  const where = isPhone ? 'WhatsApp' : isEmail ? 'email' : channelLabel(to.channel);
  const isNft = Boolean(nftTokenId);
  const isToken = Boolean(tokenAddress) && !isNft;
  const asset = isNft || isToken
    ? String(tokenSymbol || intent.asset || 'TOKEN').toUpperCase()
    : chain.nativeSymbol || 'ETH';
  const amountLine = formatClaimAmount({
    amount_eth: amountEth,
    asset,
    nft_token_id: nftTokenId,
  });

  const tg = !isPhone && !isEmail && String(to.channel || '').toLowerCase() === 'telegram';
  const receiveStep = isPhone
    ? 'They only receive after that WhatsApp links Flizy'
    : isEmail
      ? 'They only receive after they sign up or log in with that email and claim'
      : tg
        ? 'They only receive after they open Flizy on Telegram and link that account'
        : `They only receive after they sign in with ${where} and link Flizy`;
  const steps = [
    `Hold ${amountLine} from your agent wallet`,
    `Reserve for ${label} (pending claim)`,
    receiveStep,
    'You can cancel anytime: flizy cancel claims',
  ];

  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    intent: 'CLAIM_HOLD',
    input: {
      amount: amountEth,
      asset,
      currency: asset,
      recipient: label,
      recipientAddress: null,
      recipientLabel: label,
      recipientKind: to.kind,
      recipientChannel: isPhone || isEmail ? null : to.channel,
      toWaHint: isPhone ? to.phone : null,
      toEmail: isEmail ? to.email : null,
      nftTokenId: nftTokenId || null,
    },
    steps,
    estimated: {
      amountEth: isToken || isNft ? null : amountEth,
      amount: amountEth,
      asset,
      gasBufferEth,
      fromBalanceEth: fromBalanceEth ?? null,
      tokenBalance: tokenBalance ?? null,
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
      tokenAddress: tokenAddress || null,
      nftTokenId: nftTokenId || null,
    },
  };
}

function formatClaimPlanPreview(plan) {
  const mins = Math.max(1, Math.round((plan.expiresAt - plan.createdAt) / 60000));
  const kind = plan.input.recipientKind || 'phone';
  const isPhone = kind === 'phone';
  const isEmail = kind === 'email';
  const isPlatform = kind === 'platform';
  const where = isPhone ? 'WhatsApp' : isEmail ? 'email' : channelLabel(plan.input.recipientChannel);
  const isTelegram =
    isPlatform && String(plan.input.recipientChannel || '').toLowerCase() === 'telegram';
  const tgPending =
    isTelegram &&
    plan.route?.recipient &&
    (plan.route.recipient.pendingUsername ||
      String(plan.route.recipient.externalId || '').startsWith('tguser:'));

  const title = isPhone
    ? 'Claim plan (hold for phone)'
    : isEmail
      ? 'Claim plan (hold for email)'
      : `Claim plan (hold for ${plan.input.recipient})`;

  const receiveLine = isPhone
    ? 'They only see/receive this after that WhatsApp links Flizy.'
    : isEmail
      ? 'This email may not be on Flizy yet. Funds stay locked until that address is verified on a Flizy account and claimed.'
      : isTelegram
        ? tgPending
          ? 'This Telegram user is not on Flizy yet (or we could not resolve their id). Funds stay locked until that @username links Flizy Telegram and claims.'
          : 'This Telegram user may not be on Flizy yet. Funds stay locked until this Telegram account is linked and they claim.'
        : `They only see/receive this after they sign in with ${where} and link Flizy.`;

  const caution = isPhone
    ? []
    : isEmail
      ? ['Check the address carefully. A mistyped email is a different person.']
      : [
          'Check the handle carefully. A lookalike handle is a different person.',
          isTelegram
            ? tgPending
              ? 'Until they join, this hold is by @username. Whoever links that exact @name can claim — double-check the spelling.'
              : 'Funds are locked to this Telegram account id (not the @name forever).'
            : null,
        ].filter(Boolean);

  return [
    title,
    '',
    `Amount:  ${formatClaimAmount({
      amount_eth: plan.input.amount,
      asset: plan.input.asset,
      nft_token_id: plan.route?.nftTokenId || plan.input.nftTokenId,
    })}`,
    `For:     ${plan.input.recipient}`,
    `From:    ${shortAddr(plan.route.fromAddress)} (your agent wallet)`,
    `Chain:   ${plan.route.chainName}`,
    '',
    receiveLine,
    ...caution,
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
 * @param {string} [args.targetOutDisplay] set when the user named the amount they
 *   want to RECEIVE ("buy 100 FLZ"), so the preview can say which side they pinned
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
  targetOutDisplay,
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
      targetOut: targetOutDisplay || null,
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
  // When the user named the amount they want to receive, say so on its own
  // line. "buy 100 FLZ" and "buy 100 ETH of FLZ" must never look alike here.
  const target = plan.input.targetOut
    ? [`You asked for: ${plan.input.targetOut} ${plan.input.tokenOutLabel}`]
    : [];
  return [
    'Swap plan',
    '',
    ...target,
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
