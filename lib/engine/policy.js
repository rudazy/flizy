/**
 * Policy Engine — decide if an intent is allowed, and under what conditions.
 * Trusted list, limits, session, daily caps, and (later) TrustGate risk all live here.
 *
 * HARD RULE: no client enforces money rules. Only this module (and related Policy helpers).
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const {
  isTrustedAddress,
  rejectUntrustedMessage,
  trustedHoldRemainingMs,
  trustedHoldMessage,
} = require('../trusted');
const { checkDailySendLimit } = require('../dailyLimits');
const { isAllowedSwapRouter } = require('../dex');
const { sessionGate } = require('../session');
const { potStillPayable } = require('../pots');

/** @typedef {'ALLOW' | 'ALLOW_WITH_CONFIRM' | 'DENY'} PolicyDecision */

/** What each sessionGate refusal says. */
const SESSION_DENIAL = {
  session_locked: 'Session locked. Send: {{cmd:unlock}}\nThen reply with your unlock PIN.',
  no_pin: `Chat cannot move money until your account has an unlock PIN.\nSet one on the site: ${config.siteUrl}/dashboard/account`,
  no_context: 'Could not confirm who is sending, so nothing was sent.',
  session_unavailable:
    'Could not check your session right now, so nothing was sent.\nTry again shortly.',
};

/**
 * The unlock check every money policy runs. The state is read here from who is
 * acting; nothing the caller says about being unlocked is consulted.
 * @returns {Promise<object|null>} a DENY result, or null to carry on
 */
async function denyIfSessionClosed(actor, requireUnlock, checks) {
  const gate = await sessionGate(actor, { requireUnlock });
  if (gate.ok) {
    checks.sessionOk = true;
    return null;
  }
  checks.sessionOk = false;
  return {
    decision: 'DENY',
    reason: gate.reason,
    message: SESSION_DENIAL[gate.reason] || SESSION_DENIAL.no_context,
    checks,
  };
}

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
    // Whether the allowlist was actually consulted. checks.trusted is set to
    // true when it was skipped, which reads as "this address is on the list"
    // when the truth is "nobody looked". The confirm preview needs to tell
    // those apart to say so on screen, so it is recorded separately.
    trustedEnforced: enforceTrusted,
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
        'Link your site account first.\nOpen the Flizy dashboard, generate a code, then send:\n{{cmd:link CODE}}',
      checks,
    };
  }
  checks.linked = true;

  const sessionDenied = await denyIfSessionClosed(intent.actor, requireUnlock, checks);
  if (sessionDenied) return sessionDenied;

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
        message: 'Amount must be greater than 0.\nExample: {{cmd:send 0.001 to john}}\nOr: {{cmd:send 10 FLZ to john}}',
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
      message: 'Invalid amount.\nExample: {{cmd:send 0.001 to john}}\nOr: {{cmd:send 10 FLZ to john}}',
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

    if (!opts.skipDailyLimit) {
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
        // Fail closed. This used to allow the send, which meant an unreachable
        // database silently switched the daily cap off for everyone. A spend
        // limit that disappears under failure is not a limit.
        console.error('daily limit check failed:', err && err.message ? err.message : err);
        checks.dailyOk = false;
        return {
          decision: 'DENY',
          reason: 'daily_limit_unavailable',
          message:
            'Could not verify your daily limit right now, so this send was not made.\nTry again shortly.',
          checks,
        };
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
        'Could not resolve recipient.\nAdd a trusted name on the site, or:\n{{cmd:send 0.001 to john}}',
      checks,
    };
  }

  if (enforceTrusted) {
    const ok = await isTrustedAddress(accountId, intent.toAddress);
    checks.trusted = ok;
    if (!ok) {
      // The decision is already made and does not depend on what follows. This
      // only picks the wording: a destination inside its 24 hour hold was added
      // correctly, and telling that owner to go and add it reads as the product
      // having lost their work. Errors here fall back to the generic copy.
      let message = rejectUntrustedMessage();
      try {
        const heldMs = await trustedHoldRemainingMs(accountId, intent.toAddress);
        if (heldMs > 0) message = trustedHoldMessage(heldMs);
      } catch {
        /* wording only; the refusal stands either way */
      }
      return {
        decision: 'DENY',
        reason: 'untrusted',
        message,
        checks,
      };
    }
  } else {
    checks.trusted = true;
  }

  if (isNative && enforceCredit) {
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
          'Send: {{cmd:deposit}}',
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
        'Link your site account first.\nOpen the Flizy dashboard, generate a code, then send:\n{{cmd:link CODE}}',
      checks,
    };
  }
  checks.linked = true;

  const sessionDenied = await denyIfSessionClosed(intent.actor, requireUnlock, checks);
  if (sessionDenied) return sessionDenied;

  try {
    const wei = ethers.parseEther(String(intent.amountIn));
    if (wei <= 0n) {
      return {
        decision: 'DENY',
        reason: 'amount_zero',
        message: 'Amount must be greater than 0.\nExample: {{cmd:buy 0.01 FLZ}}',
        checks,
      };
    }
    checks.amountValid = true;
  } catch {
    return {
      decision: 'DENY',
      reason: 'amount_invalid',
      message: 'Invalid amount.\nExample: {{cmd:buy 0.01 FLZ}}',
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

/**
 * The checks a plan passed when it was made, read again at CONFIRM.
 *
 * A plan can wait minutes for its CONFIRM. In that time the unlock can lapse,
 * the owner can lock the chat or change the password (which locks every chat),
 * the owner can take the destination off the trusted list on the site, and a
 * pot's organiser can close it.
 * Each of those is meant to stop money moving, so each is read again here
 * instead of being carried over from when the plan was made.
 *
 * Fails closed: a trusted list that cannot be read stops the send.
 *
 * @param {{ accountId?: string, channel?: string, externalId?: string }} actor
 *   the chat confirming, which is the chat that made the plan (plans are kept per chat)
 * @param {object} plan
 * @param {{ requireUnlock?: boolean }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, message: string }>}
 */
async function recheckAtConfirm(actor, plan, opts = {}) {
  const requireUnlock = opts.requireUnlock ?? config.requireUnlock;
  const gate = await sessionGate(actor, { requireUnlock });
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason,
      message: SESSION_DENIAL[gate.reason] || SESSION_DENIAL.no_context,
    };
  }

  // Only a plan that was checked against the list is checked again. A plan
  // that skipped it (a payment request, a pay code) was shown as not on the
  // trusted list when it was confirmed.
  if (plan?.policyChecks?.trustedEnforced === true) {
    const to = plan.route?.toAddress || plan.input?.recipientAddress || null;
    let trusted;
    try {
      trusted = Boolean(to) && (await isTrustedAddress(actor.accountId, to));
    } catch (err) {
      console.error('confirm trusted check failed:', err && err.message ? err.message : err);
      return {
        ok: false,
        reason: 'trusted_unavailable',
        message: 'Could not check your trusted list right now, so nothing was sent.\nTry again shortly.',
      };
    }
    if (!trusted) {
      return { ok: false, reason: 'untrusted', message: rejectUntrustedMessage() };
    }
  }

  // A pot payment skips the trusted list, so what it was checked against is
  // the pot itself: still open, and still owned by the wallet it pays.
  if (plan?.potId) {
    let pot;
    try {
      pot = await potStillPayable(plan.potId, plan.route?.toAddress || plan.input?.recipientAddress || null);
    } catch (err) {
      console.error('confirm pot check failed:', err && err.message ? err.message : err);
      return {
        ok: false,
        reason: 'pot_unavailable',
        message: 'Could not check that pot right now, so nothing was sent.\nTry again shortly.',
      };
    }
    if (!pot.ok) {
      return {
        ok: false,
        reason: pot.reason,
        message:
          pot.reason === 'pot_closed'
            ? 'That pot is closed. It is no longer collecting.'
            : 'That pot is not paying the same wallet any more. Start again from its code.',
      };
    }
  }

  return { ok: true };
}

module.exports = {
  evaluateSendPolicy,
  evaluateClaimHoldPolicy,
  evaluateSwapPolicy,
  recheckAtConfirm,
};
