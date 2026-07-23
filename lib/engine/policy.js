/**
 * Policy Engine — decide if an intent is allowed, and under what conditions.
 * Trusted list, limits, session, daily caps, and (later) TrustGate risk all live here.
 *
 * HARD RULE: no client enforces money rules. Only this module (and related Policy helpers).
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const { isTrustedAddress, rejectUntrustedMessage } = require('../trusted');
const { checkDailySendLimit } = require('../dailyLimits');
const { isAllowedSwapRouter } = require('../dex');

/** @typedef {'ALLOW' | 'ALLOW_WITH_CONFIRM' | 'DENY'} PolicyDecision */

/**
 * Evaluate a send intent against account policy.
 * Does not talk to chain for balances (plan builder does).
 *
 * @param {import('./intent').SendIntent} intent
 * @param {{
 *   enforceTrusted?: boolean,
 *   enforceCredit?: boolean,
 *   maxSendEth?: number,
 *   requireUnlock?: boolean,
 *   skipDailyLimit?: boolean,
 *   accountRow?: { daily_send_limit_eth?: number|string|null }|null,
 * }} [opts]
 * @returns {Promise<import('./policy').PolicyResult|object>}
 */
async function evaluateSendPolicy(intent, opts = {}) {
  const enforceTrusted = opts.enforceTrusted ?? config.enforceTrusted;
  const enforceCredit = opts.enforceCredit ?? config.enforceCredit;
  const maxSendEth = opts.maxSendEth ?? config.maxSendEth;
  const requireUnlock = opts.requireUnlock ?? config.requireUnlock;

  const checks = {
    linked: false,
    amountValid: false,
    underMax: false,
    trusted: null,
    creditOk: null,
    sessionOk: null,
    dailyOk: null,
  };

  const accountId = intent.actor?.accountId;
  if (!accountId) {
    return {
      decision: 'DENY',
      reason: 'not_linked',
      message:
        'Link your site account first.\nOpen the Flizy dashboard, generate a code, then send:\nflizy link CODE',
      checks,
    };
  }
  checks.linked = true;

  if (requireUnlock && intent.actor.hasPin && !intent.actor.isAdmin) {
    if (!intent.actor.sessionUnlocked) {
      checks.sessionOk = false;
      return {
        decision: 'DENY',
        reason: 'session_locked',
        message: 'Session locked. Send:\nflizy unlock your-pin',
        checks,
      };
    }
    checks.sessionOk = true;
  } else {
    checks.sessionOk = true;
  }

  const assetRaw = String(intent.asset || 'native').toUpperCase();
  const isNative =
    !intent.asset ||
    assetRaw === 'NATIVE' ||
    assetRaw === 'ETH' ||
    assetRaw === (opts.nativeSymbol || 'ETH').toUpperCase();

  let amountNum;
  try {
    const wei = ethers.parseEther(String(intent.amountEth));
    if (wei <= 0n) {
      return {
        decision: 'DENY',
        reason: 'amount_zero',
        message: 'Amount must be greater than 0.\nExample: flizy send 0.001 to john\nOr: flizy send 10 FLZ to john',
        checks,
      };
    }
    amountNum = Number(intent.amountEth);
    if (!Number.isFinite(amountNum)) {
      throw new Error('nan');
    }
    checks.amountValid = true;
  } catch {
    return {
      decision: 'DENY',
      reason: 'amount_invalid',
      message: 'Invalid amount.\nExample: flizy send 0.001 to john\nOr: flizy send 10 FLZ to john',
      checks,
    };
  }

  // Per-tx max and daily volume limits apply to native ETH only
  if (isNative) {
    if (amountNum > maxSendEth) {
      checks.underMax = false;
      return {
        decision: 'DENY',
        reason: 'over_max',
        message: `Max per send is ${maxSendEth} ETH.\nTry a smaller amount.`,
        checks,
      };
    }
    checks.underMax = true;

    if (!opts.skipDailyLimit && !intent.actor.isAdmin) {
      try {
        const daily = await checkDailySendLimit(accountId, intent.amountEth, opts.accountRow || {});
        checks.dailyOk = daily.ok;
        if (!daily.ok) {
          return {
            decision: 'DENY',
            reason: 'daily_limit',
            message: daily.message || 'Daily send limit reached.',
            checks,
          };
        }
      } catch (err) {
        console.error('daily limit check failed:', err && err.message ? err.message : err);
        checks.dailyOk = true;
      }
    } else {
      checks.dailyOk = true;
    }
  } else {
    checks.underMax = true;
    checks.dailyOk = true;
  }

  if (!intent.toAddress || !ethers.isAddress(intent.toAddress)) {
    return {
      decision: 'DENY',
      reason: 'recipient_missing',
      message:
        'Could not resolve recipient.\nAdd a trusted name on the site, or:\nflizy send 0.001 to john',
      checks,
    };
  }

  if (enforceTrusted) {
    const ok = await isTrustedAddress(accountId, intent.toAddress);
    checks.trusted = ok;
    if (!ok) {
      return {
        decision: 'DENY',
        reason: 'untrusted',
        message: rejectUntrustedMessage(),
        checks,
      };
    }
  } else {
    checks.trusted = true;
  }

  if (isNative && enforceCredit && !intent.actor.isAdmin) {
    const credit = Number(intent.actor.creditEth || 0);
    checks.creditOk = credit >= amountNum;
    if (!checks.creditOk) {
      return {
        decision: 'DENY',
        reason: 'insufficient_credit',
        message: [
          'Not enough spendable credit.',
          `You have ${credit} ETH credit.`,
          `Need ${intent.amountEth} ETH.`,
          '',
          'Send: flizy deposit',
        ].join('\n'),
        checks,
      };
    }
  } else {
    checks.creditOk = true;
  }

  return {
    decision: 'ALLOW_WITH_CONFIRM',
    reason: 'ok',
    checks,
  };
}

/**
 * Policy for claim-hold (phone) — same limits/session, no trusted destination.
 */
async function evaluateClaimHoldPolicy(intent, opts = {}) {
  const base = {
    ...intent,
    toAddress: '0x0000000000000000000000000000000000000001',
  };
  return evaluateSendPolicy(base, {
    ...opts,
    enforceTrusted: false,
  }).then((r) => {
    if (r.reason === 'recipient_missing' || r.reason === 'untrusted') {
      return { decision: 'ALLOW_WITH_CONFIRM', reason: 'ok', checks: { ...r.checks, trusted: true } };
    }
    // Strip fake trusted allow when we only used placeholder
    if (r.decision === 'ALLOW_WITH_CONFIRM') {
      return r;
    }
    return r;
  });
}

/**
 * Policy for swaps.
 *
 * HARD RULES:
 * - Swaps are NOT checked against trusted contacts (destination is a router).
 * - Swaps do NOT consume daily send limit (funds stay in the user agent wallet
 *   as another asset; only transfers/claims count toward daily send).
 * - Only allowlisted routers may be used.
 *
 * @param {import('./intent').createSwapIntent extends Function ? object : object} intent
 * @param {{ requireUnlock?: boolean }} [opts]
 */
async function evaluateSwapPolicy(intent, opts = {}) {
  const requireUnlock = opts.requireUnlock ?? config.requireUnlock;
  const checks = {
    linked: false,
    amountValid: false,
    sessionOk: null,
    routerAllowlisted: false,
    /** Explicit: swaps skip daily send limit by design */
    dailySendLimitApplies: false,
    trustedContactsApplies: false,
  };

  const accountId = intent.actor?.accountId;
  if (!accountId) {
    return {
      decision: 'DENY',
      reason: 'not_linked',
      message:
        'Link your site account first.\nOpen the Flizy dashboard, generate a code, then send:\nflizy link CODE',
      checks,
    };
  }
  checks.linked = true;

  if (requireUnlock && intent.actor.hasPin && !intent.actor.isAdmin) {
    if (!intent.actor.sessionUnlocked) {
      checks.sessionOk = false;
      return {
        decision: 'DENY',
        reason: 'session_locked',
        message: 'Session locked. Send:\nflizy unlock your-pin',
        checks,
      };
    }
    checks.sessionOk = true;
  } else {
    checks.sessionOk = true;
  }

  try {
    const wei = ethers.parseEther(String(intent.amountIn));
    if (wei <= 0n) {
      return {
        decision: 'DENY',
        reason: 'amount_zero',
        message: 'Amount must be greater than 0.\nExample: flizy buy 0.01 FLZ',
        checks,
      };
    }
    checks.amountValid = true;
  } catch {
    return {
      decision: 'DENY',
      reason: 'amount_invalid',
      message: 'Invalid amount.\nExample: flizy buy 0.01 FLZ',
      checks,
    };
  }

  const router = intent.routerAddress;
  if (!router || !ethers.isAddress(router) || !isAllowedSwapRouter(router, intent.chainId)) {
    checks.routerAllowlisted = false;
    return {
      decision: 'DENY',
      reason: 'router_not_allowlisted',
      message: 'That swap router is not allowed. Only Flizy DEX routers can be used.',
      checks,
    };
  }
  checks.routerAllowlisted = true;

  return {
    decision: 'ALLOW_WITH_CONFIRM',
    reason: 'ok',
    checks,
  };
}

module.exports = {
  evaluateSendPolicy,
  evaluateClaimHoldPolicy,
  evaluateSwapPolicy,
};
