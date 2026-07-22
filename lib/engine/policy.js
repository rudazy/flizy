/**
 * Policy Engine — decide if an intent is allowed, and under what conditions.
 * Trusted list, limits, session, and (later) TrustGate risk all live here.
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const { isTrustedAddress, rejectUntrustedMessage } = require('../trusted');

/** @typedef {'ALLOW' | 'ALLOW_WITH_CONFIRM' | 'DENY'} PolicyDecision */

/**
 * @typedef {object} PolicyResult
 * @property {PolicyDecision} decision
 * @property {string} [reason] machine code
 * @property {string} [message] user-facing copy
 * @property {object} [checks]
 */

/**
 * Evaluate a send intent against account policy.
 * Does not talk to chain (balances checked in plan builder).
 *
 * @param {import('./intent').SendIntent} intent
 * @param {{ enforceTrusted?: boolean, enforceCredit?: boolean, maxSendEth?: number, requireUnlock?: boolean }} [opts]
 * @returns {Promise<PolicyResult>}
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

  // Session unlock (only when PIN is set)
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

  let amountNum;
  try {
    const wei = ethers.parseEther(String(intent.amountEth));
    if (wei <= 0n) {
      return {
        decision: 'DENY',
        reason: 'amount_zero',
        message: 'Amount must be greater than 0.\nExample: flizy send 0.001 to john',
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
      message: 'Invalid amount.\nExample: flizy send 0.001 to john',
      checks,
    };
  }

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

  if (enforceCredit && !intent.actor.isAdmin) {
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

module.exports = {
  evaluateSendPolicy,
};
