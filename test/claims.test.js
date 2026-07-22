/**
 * Claim helpers (no network).
 * Run: node --test test/claims.test.js test/engine.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeWaHint,
  isPlausiblePhone,
  formatClaimsMenu,
} = require('../lib/claims');
const { buildClaimPlan, formatClaimPlanPreview } = require('../lib/engine/plan');
const { createSendIntent } = require('../lib/engine/intent');

describe('normalizeWaHint / isPlausiblePhone', () => {
  it('strips plus and non-digits', () => {
    assert.equal(normalizeWaHint('+234 801 234 5678'), '2348012345678');
    assert.equal(normalizeWaHint('2348012345678@c.us'), '2348012345678');
  });

  it('accepts plausible lengths', () => {
    assert.equal(isPlausiblePhone('2348012345678'), true);
    assert.equal(isPlausiblePhone('12345'), false);
  });
});

describe('formatClaimsMenu', () => {
  it('lists outgoing with All prompt', () => {
    const text = formatClaimsMenu(
      [
        { to_wa_hint: '2348011111111', amount_eth: '0.01', created_at: new Date().toISOString() },
        { to_wa_hint: '2348022222222', amount_eth: '0.02', created_at: new Date().toISOString() },
      ],
      'outgoing'
    );
    assert.match(text, /1\./);
    assert.match(text, /2\./);
    assert.match(text, /All/i);
    assert.match(text, /2348011111111/);
  });

  it('empty outgoing', () => {
    const text = formatClaimsMenu([], 'outgoing');
    assert.match(text, /No pending claims/);
  });
});

describe('claim plan preview', () => {
  it('mentions cancel claims', () => {
    const intent = createSendIntent({
      actor: {
        accountId: 'a1',
        waSenderId: '2348000000000',
        isAdmin: false,
        sessionUnlocked: true,
        hasPin: false,
      },
      amountEth: '0.001',
      toLabel: '+2348012345678',
    });
    const plan = buildClaimPlan({
      intent,
      policy: { decision: 'ALLOW_WITH_CONFIRM' },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      toWaHint: '2348012345678',
      fromBalanceEth: '1',
    });
    assert.equal(plan.intent, 'CLAIM_HOLD');
    const preview = formatClaimPlanPreview(plan);
    assert.match(preview, /cancel claims/i);
    assert.match(preview, /2348012345678/);
  });
});
