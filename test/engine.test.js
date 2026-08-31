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
const { formatSendPending, formatSendReceipt } = require('../lib/engine/receipt');

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

/**
 * The confirm screen is the last thing anyone reads before money moves, so it
 * carries only what they are deciding on. The plan still holds its steps —
 * engines and the stored plan record need them — but "check balance" and
 * "write receipt" are Flizy's work, not the user's decision, and printing them
 * doubles the length of the message for no gain.
 */
describe('send preview shows the decision, not the execution plan', () => {
  function sendPlan(over = {}) {
    const intent = createSendIntent({
      actor: baseActor(),
      amountEth: '0.005',
      toAddress: TRUSTED,
      toLabel: 'ludarep',
    });
    return buildSendPlan({
      intent,
      policy: { decision: 'ALLOW_WITH_CONFIRM', checks: { trusted: true } },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x851E000000000000000000000000000000005d8D',
      fromBalanceEth: '1.0',
      ...over,
    });
  }

  it('never prints the internal step list', () => {
    const text = formatPlanPreview(sendPlan());
    assert.equal(text.includes('Steps'), false);
    assert.equal(/Wait for network confirmation/.test(text), false);
    assert.equal(/Write receipt/.test(text), false);
    assert.equal(/Check .* balance on/.test(text), false);
  });

  it('still builds the steps onto the plan itself', () => {
    // Dropping them from the preview must not drop them from the record.
    assert.ok(sendPlan().steps.length >= 3);
  });

  it('keeps every fact the decision rests on', () => {
    const text = formatPlanPreview(sendPlan());
    assert.match(text, /Amount:\s+0\.005 ETH/);
    assert.match(text, /To:\s+ludarep \(0x1111\.\.\.1111\)/);
    assert.match(text, /From:\s+0x851E\.\.\.5d8D/);
    assert.match(text, /Chain:\s+GIWA Sepolia/);
  });

  it('offers confirm and cancel as equal choices, then says when it expires', () => {
    // "Or: cancel" read as an afterthought. Both ways out sit on one line.
    const text = formatPlanPreview(sendPlan());
    assert.match(text, /Reply CONFIRM to send, or CANCEL to stop\./);
    assert.match(text, /Expires in \d+ minutes?\./);
    assert.equal(/Or: cancel/.test(text), false);
  });

  it('names the wallet the way a user would, not the way the code does', () => {
    const text = formatPlanPreview(sendPlan());
    assert.match(text, /your Flizy wallet/);
    assert.equal(/agent wallet/i.test(text), false);
  });
});

/**
 * The line sent while the transaction is in flight. It exists so a slow network
 * reads as "still going" instead of "the bot stopped answering", which means it
 * has to name the same amount and recipient the receipt will.
 */
describe('formatSendPending', () => {
  const basePlan = {
    input: { amount: '0.005', asset: 'ETH', recipientLabel: 'ludarep', recipientAddress: TRUSTED },
    route: { chainName: 'GIWA Sepolia' },
  };

  it('names the amount and who it is going to', () => {
    assert.equal(formatSendPending(basePlan), 'Sending 0.005 ETH to ludarep...');
  });

  it('falls back to a short address when there is no label', () => {
    const text = formatSendPending({
      ...basePlan,
      input: { ...basePlan.input, recipientLabel: null },
    });
    assert.equal(text, 'Sending 0.005 ETH to 0x1111...1111...');
  });

  it('renders an NFT send the way the rest of the product does', () => {
    const text = formatSendPending({
      input: { amount: '1', asset: 'giwaforge', recipientLabel: 'bob', recipientAddress: OTHER },
      route: { chainName: 'GIWA Sepolia', nftTokenId: '21' },
    });
    assert.equal(text, 'Sending giwaforge #21 to bob...');
  });

  it('never throws when there is no plan to describe', () => {
    assert.equal(formatSendPending(null), 'Sending...');
    assert.equal(formatSendPending({}), 'Sending...');
  });
});
