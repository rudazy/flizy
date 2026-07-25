/**
 * A Telegram-built intent must hit exactly the same Policy decisions as the
 * WhatsApp one. Policy is the only place money rules live; a new client must
 * not be able to widen them.
 *
 * Run: node --test test/telegramPolicy.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Mock trusted before loading policy
const trustedPath = require.resolve('../lib/trusted');
require.cache[trustedPath] = {
  id: trustedPath,
  filename: trustedPath,
  loaded: true,
  exports: {
    isTrustedAddress: async (accountId, address) =>
      accountId === 'acc-ok' &&
      String(address).toLowerCase() === '0x1111111111111111111111111111111111111111',
    rejectUntrustedMessage: () => 'That destination is not allowed.',
    addTrusted: async () => ({}),
    removeTrusted: async () => {},
    listTrusted: async () => [],
  },
};

const { createSendIntent, createSwapIntent } = require('../lib/engine/intent');
const { evaluateSendPolicy, evaluateSwapPolicy } = require('../lib/engine/policy');
const { identityTransferKey } = require('../lib/identity');

const TRUSTED = '0x1111111111111111111111111111111111111111';
const UNTRUSTED = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';

/** Same person, same account, two channels. */
function actorFor(channel, over = {}) {
  const externalId = channel === 'telegram' ? '778899123' : '2348012345678';
  return {
    accountId: 'acc-ok',
    userId: 'user-1',
    waSenderId: identityTransferKey(channel, externalId),
    isAdmin: false,
    creditEth: 1,
    sessionUnlocked: true,
    hasPin: false,
    ...over,
  };
}

const CHANNELS_UNDER_TEST = ['whatsapp', 'telegram'];

async function sendDecisionFor(channel, { amountEth, toAddress, actorOver, opts }) {
  const intent = createSendIntent({
    actor: actorFor(channel, actorOver),
    amountEth,
    toAddress,
    toLabel: 'john',
  });
  return evaluateSendPolicy(intent, opts);
}

describe('send policy is identical on every channel', () => {
  it('denies an untrusted destination on both channels', async () => {
    for (const channel of CHANNELS_UNDER_TEST) {
      const r = await sendDecisionFor(channel, {
        amountEth: '0.01',
        toAddress: UNTRUSTED,
        opts: { enforceTrusted: true },
      });
      assert.equal(r.decision, 'DENY', channel);
      assert.equal(r.reason, 'untrusted', channel);
    }
  });

  it('denies over the per-send max on both channels', async () => {
    for (const channel of CHANNELS_UNDER_TEST) {
      const r = await sendDecisionFor(channel, {
        amountEth: '10',
        toAddress: TRUSTED,
        opts: { maxSendEth: 0.1, enforceTrusted: true },
      });
      assert.equal(r.decision, 'DENY', channel);
      assert.equal(r.reason, 'over_max', channel);
    }
  });

  it('denies a locked session on both channels', async () => {
    for (const channel of CHANNELS_UNDER_TEST) {
      const r = await sendDecisionFor(channel, {
        amountEth: '0.01',
        toAddress: TRUSTED,
        actorOver: { hasPin: true, sessionUnlocked: false },
        opts: { enforceTrusted: true, requireUnlock: true },
      });
      assert.equal(r.decision, 'DENY', channel);
      assert.equal(r.reason, 'session_locked', channel);
    }
  });

  it('denies an unlinked identity on both channels', async () => {
    for (const channel of CHANNELS_UNDER_TEST) {
      const r = await sendDecisionFor(channel, {
        amountEth: '0.01',
        toAddress: TRUSTED,
        actorOver: { accountId: null },
        opts: { enforceTrusted: true },
      });
      assert.equal(r.decision, 'DENY', channel);
      assert.equal(r.reason, 'not_linked', channel);
    }
  });

  it('denies an invalid amount on both channels', async () => {
    for (const channel of CHANNELS_UNDER_TEST) {
      const r = await sendDecisionFor(channel, {
        amountEth: 'nope',
        toAddress: TRUSTED,
        opts: { enforceTrusted: true },
      });
      assert.equal(r.decision, 'DENY', channel);
      assert.equal(r.reason, 'amount_invalid', channel);
    }
  });

  it('denies insufficient credit identically when credit is enforced', async () => {
    for (const channel of CHANNELS_UNDER_TEST) {
      const r = await sendDecisionFor(channel, {
        amountEth: '0.05',
        toAddress: TRUSTED,
        actorOver: { creditEth: 0.001 },
        opts: { enforceTrusted: true, enforceCredit: true, skipDailyLimit: true },
      });
      assert.equal(r.decision, 'DENY', channel);
      assert.equal(r.reason, 'insufficient_credit', channel);
    }
  });

  it('allows a trusted send with confirm on both channels, with the same checks', async () => {
    const results = {};
    for (const channel of CHANNELS_UNDER_TEST) {
      results[channel] = await sendDecisionFor(channel, {
        amountEth: '0.01',
        toAddress: TRUSTED,
        opts: {
          enforceTrusted: true,
          enforceCredit: false,
          maxSendEth: 0.1,
          skipDailyLimit: true,
        },
      });
    }
    assert.equal(results.telegram.decision, 'ALLOW_WITH_CONFIRM');
    assert.deepEqual(results.telegram.checks, results.whatsapp.checks);
    assert.equal(results.telegram.decision, results.whatsapp.decision);
  });
});

describe('swap policy is identical on every channel', () => {
  function swapIntentFor(channel, over = {}) {
    return createSwapIntent({
      actor: actorFor(channel, over.actorOver),
      side: 'buy',
      amountIn: over.amountIn || '0.01',
      tokenInLabel: 'ETH',
      tokenOutLabel: 'FLZ',
      tokenIn: null,
      tokenOut: '0x4444444444444444444444444444444444444444',
      routerAddress: over.routerAddress === undefined ? ROUTER : over.routerAddress,
      chainId: 'giwa_sepolia',
    });
  }

  it('denies a router that is not allowlisted on both channels', async () => {
    for (const channel of CHANNELS_UNDER_TEST) {
      const r = await evaluateSwapPolicy(swapIntentFor(channel));
      assert.equal(r.decision, 'DENY', channel);
      assert.equal(r.reason, 'router_not_allowlisted', channel);
    }
  });

  it('denies a locked session before it ever looks at the router', async () => {
    for (const channel of CHANNELS_UNDER_TEST) {
      const r = await evaluateSwapPolicy(
        swapIntentFor(channel, { actorOver: { hasPin: true, sessionUnlocked: false } }),
        { requireUnlock: true }
      );
      assert.equal(r.decision, 'DENY', channel);
      assert.equal(r.reason, 'session_locked', channel);
    }
  });
});
