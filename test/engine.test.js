/**
 * Phase 0 engine tests — policy + plan (no network).
 * Run: node --test test/engine.test.js
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
    isTrustedAddress: async (accountId, address) => {
      if (accountId === 'acc-ok' && String(address).toLowerCase() === '0x1111111111111111111111111111111111111111') {
        return true;
      }
      return false;
    },
    rejectUntrustedMessage: () => 'That destination is not allowed.',
    addTrusted: async () => ({}),
    removeTrusted: async () => {},
    listTrusted: async () => [],
  },
};

const { createSendIntent } = require('../lib/engine/intent');
const { evaluateSendPolicy } = require('../lib/engine/policy');
const { buildSendPlan, formatPlanPreview, assertPlanFunded } = require('../lib/engine/plan');
const { formatSendReceipt } = require('../lib/engine/receipt');

const TRUSTED = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

function baseActor(over = {}) {
  return {
    accountId: 'acc-ok',
    userId: 'user-1',
    waSenderId: '2348012345678',
    isAdmin: false,
    creditEth: 1,
    sessionUnlocked: true,
    hasPin: false,
    ...over,
  };
}

describe('createSendIntent', () => {
  it('normalizes amount and kind', () => {
    const intent = createSendIntent({
      actor: baseActor(),
      amountEth: '0.01',
      toAddress: TRUSTED,
      toLabel: 'john',
    });
    assert.equal(intent.kind, 'send');
    assert.equal(intent.amountEth, '0.01');
    assert.equal(intent.toLabel, 'john');
  });
});

describe('evaluateSendPolicy', () => {
  it('denies when not linked', async () => {
    const intent = createSendIntent({
      actor: baseActor({ accountId: null }),
      amountEth: '0.01',
      toAddress: TRUSTED,
    });
    const r = await evaluateSendPolicy(intent, { enforceTrusted: true });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'not_linked');
  });

  it('denies invalid amount', async () => {
    const intent = createSendIntent({
      actor: baseActor(),
      amountEth: 'nope',
      toAddress: TRUSTED,
    });
    const r = await evaluateSendPolicy(intent);
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'amount_invalid');
  });

  it('denies over max', async () => {
    const intent = createSendIntent({
      actor: baseActor(),
      amountEth: '10',
      toAddress: TRUSTED,
    });
    const r = await evaluateSendPolicy(intent, { maxSendEth: 0.1 });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'over_max');
  });

  it('denies untrusted destination', async () => {
    const intent = createSendIntent({
      actor: baseActor(),
      amountEth: '0.01',
      toAddress: OTHER,
    });
    const r = await evaluateSendPolicy(intent, { enforceTrusted: true });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'untrusted');
  });

  it('denies locked session when PIN set', async () => {
    const intent = createSendIntent({
      actor: baseActor({ hasPin: true, sessionUnlocked: false }),
      amountEth: '0.01',
      toAddress: TRUSTED,
    });
    const r = await evaluateSendPolicy(intent, {
      enforceTrusted: true,
      requireUnlock: true,
    });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'session_locked');
  });

  it('allows trusted send with confirm', async () => {
    const intent = createSendIntent({
      actor: baseActor(),
      amountEth: '0.01',
      toAddress: TRUSTED,
      toLabel: 'john',
    });
    const r = await evaluateSendPolicy(intent, {
      enforceTrusted: true,
      enforceCredit: false,
      maxSendEth: 0.1,
    });
    assert.equal(r.decision, 'ALLOW_WITH_CONFIRM');
    assert.equal(r.checks.trusted, true);
  });
});

describe('buildSendPlan + preview', () => {
  it('builds plan with steps and confirmation flag', async () => {
    const intent = createSendIntent({
      actor: baseActor(),
      amountEth: '0.001',
      toAddress: TRUSTED,
      toLabel: 'john',
    });
    const policy = { decision: 'ALLOW_WITH_CONFIRM', checks: { trusted: true } };
    const plan = buildSendPlan({
      intent,
      policy,
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      fromBalanceEth: '1.0',
    });
    assert.equal(plan.intent, 'SEND');
    assert.equal(plan.requiresConfirmation, true);
    assert.ok(plan.steps.length >= 3);
    assert.equal(plan.route.chainId, 91342);
    assert.equal(plan.input.recipientLabel, 'john');

    const preview = formatPlanPreview(plan);
    assert.match(preview, /Transfer plan/);
    assert.match(preview, /confirm/i);
    assert.match(preview, /john/i);
    assert.equal(preview.includes('First payment'), false);
  });

  it('warns on a first payment to someone new', () => {
    const intent = createSendIntent({
      actor: baseActor(),
      amountEth: '0.01',
      toAddress: OTHER,
      toLabel: '@merchant',
    });
    const plan = buildSendPlan({
      intent,
      policy: { decision: 'ALLOW_WITH_CONFIRM', checks: { trustedEnforced: false } },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      fromBalanceEth: '1.0',
      firstPay: true,
      offerSave: true,
    });
    const preview = formatPlanPreview(plan);
    assert.match(preview, /First payment\. You have not paid this person before\./);
    assert.equal(plan.input.firstPay, true);
    assert.equal(plan.input.offerSave, true);
  });

  it('assertPlanFunded rejects low balance', () => {
    const plan = {
      input: { amount: '0.5' },
      route: { fromAddress: TRUSTED },
    };
    const r = assertPlanFunded(plan, '0.01', '0.0001');
    assert.equal(r.ok, false);
    assert.match(r.message, /Not enough ETH/);
  });

  it('assertPlanFunded accepts funded wallet', () => {
    const plan = {
      input: { amount: '0.001' },
      route: { fromAddress: TRUSTED },
    };
    const r = assertPlanFunded(plan, '1.0', '0.0001');
    assert.equal(r.ok, true);
  });
});

describe('formatSendReceipt', () => {
  it('formats success with explorer', () => {
    const plan = {
      input: { amount: '0.001', asset: 'ETH', recipientLabel: 'john', recipientAddress: TRUSTED },
      route: { chainName: 'GIWA Sepolia' },
    };
    const text = formatSendReceipt(
      { ok: true, explorerUrl: 'https://example.com/tx/0xabc' },
      plan
    );
    assert.match(text, /Sent/);
    assert.match(text, /john/);
    assert.match(text, /https:\/\/example.com/);
  });

  it('formats failure message', () => {
    const text = formatSendReceipt({ ok: false, error: 'Nope' });
    assert.equal(text, 'Nope');
  });
});
