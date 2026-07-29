/**
 * A spend limit that disappears when the database is unreachable is not a limit.
 *
 * evaluateSendPolicy used to catch errors from the daily limit check and set
 * dailyOk = true, so a Supabase outage silently switched the daily cap off for
 * every account. This asserts the opposite: an unverifiable limit denies.
 *
 * Run: node --test test/policyFailClosed.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Swap the limit module for one that can be told to fail, before policy loads.
const dailyLimitsPath = require.resolve('../lib/dailyLimits');
const realDailyLimits = require('../lib/dailyLimits');

let mode = 'ok';

require.cache[dailyLimitsPath] = {
  id: dailyLimitsPath,
  filename: dailyLimitsPath,
  loaded: true,
  exports: {
    ...realDailyLimits,
    async checkDailySendLimit() {
      if (mode === 'throw') throw new Error('supabase unreachable');
      if (mode === 'over') {
        return { ok: false, message: 'Daily send limit reached.' };
      }
      return { ok: true, limitEth: '1', spentEth: '0', remainingEth: '1' };
    },
  },
};

const { evaluateSendPolicy } = require('../lib/engine/policy');

const TO = '0x1111111111111111111111111111111111111111';

function intent(overrides = {}) {
  return {
    amountEth: '0.01',
    toAddress: TO,
    asset: 'native',
    actor: {
      accountId: 'acct-1',
      isAdmin: false,
      hasPin: false,
      sessionUnlocked: true,
      creditEth: 100,
      ...(overrides.actor || {}),
    },
    ...overrides,
  };
}

const opts = { enforceTrusted: false, enforceCredit: false, requireUnlock: false };

after(() => {
  mode = 'ok';
});

describe('daily limit failure denies the send', () => {
  before(() => {
    mode = 'throw';
  });

  it('denies rather than allowing when the check throws', async () => {
    const result = await evaluateSendPolicy(intent(), opts);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.reason, 'daily_limit_unavailable');
  });

  it('records the check as failed, not passed', async () => {
    const result = await evaluateSendPolicy(intent(), opts);
    assert.equal(result.checks.dailyOk, false);
  });

  it('tells the user nothing was sent', async () => {
    const result = await evaluateSendPolicy(intent(), opts);
    assert.match(result.message, /not (be )?made|not sent/i);
    assert.match(result.message, /try again/i);
  });

  it('still lets an admin through', async () => {
    const result = await evaluateSendPolicy(
      intent({ actor: { accountId: 'acct-1', isAdmin: true, sessionUnlocked: true } }),
      opts
    );
    assert.equal(result.decision, 'ALLOW_WITH_CONFIRM');
  });

  it('does not block a token send, which has no daily cap', async () => {
    const result = await evaluateSendPolicy({ ...intent(), asset: 'FLZ' }, opts);
    assert.equal(result.decision, 'ALLOW_WITH_CONFIRM');
  });
});

describe('the normal paths are unchanged', () => {
  it('allows when the limit check passes', async () => {
    mode = 'ok';
    const result = await evaluateSendPolicy(intent(), opts);
    assert.equal(result.decision, 'ALLOW_WITH_CONFIRM');
    assert.equal(result.checks.dailyOk, true);
  });

  it('denies with the limit reason when genuinely over cap', async () => {
    mode = 'over';
    const result = await evaluateSendPolicy(intent(), opts);
    assert.equal(result.decision, 'DENY');
    assert.equal(result.reason, 'daily_limit');
  });
});
