/**
 * Invite credit: the rule for what a counted invite is worth.
 *
 * Two things are being protected here. First, the number itself, because it is
 * rendered straight into chat and onto the dashboard. Second, the freeze: this
 * product has a second thing called credit (accounts.balance_eth) that IS
 * spendable and pays for sends, and the screens tell them apart by label alone.
 *
 * Run: node --test test/inviteCredits.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../lib/inviteCredits');

/** Same inputs to both sides. Bad input is in here on purpose. */
const VECTORS = [0, 1, 2, 3, 7, 42, '0', '3', -1, -100, null, undefined, '', 'x', 2.9, 0.4];

let web;
before(async () => {
  web = await import('../web/lib/inviteCredits.ts');
});

describe('what a counted invite is worth', () => {
  it('is one credit each', () => {
    assert.equal(bot.CREDIT_PER_COUNTED_INVITE, 1);
    assert.equal(bot.creditsForCounted(0), 0);
    assert.equal(bot.creditsForCounted(1), 1);
    assert.equal(bot.creditsForCounted(3), 3);
  });

  it('reads a string count, because callers pass DB values straight in', () => {
    assert.equal(bot.creditsForCounted('7'), 7);
  });

  it('never returns NaN or a negative, whatever it is handed', () => {
    // This number goes into a chat message. "Credits: NaN" is worse than a zero.
    for (const bad of [-1, -100, null, undefined, '', 'x', {}, []]) {
      const n = bot.creditsForCounted(bad);
      assert.equal(Number.isInteger(n), true, `${JSON.stringify(bad)} gave ${n}`);
      assert.equal(n >= 0, true, `${JSON.stringify(bad)} gave ${n}`);
    }
  });

  it('does not invent a fractional credit', () => {
    assert.equal(bot.creditsForCounted(2.9), 2);
    assert.equal(bot.creditsForCounted(0.4), 0);
  });
});

describe('credits stay frozen until someone decides otherwise', () => {
  it('is not spendable', () => {
    // The interface deliberately does not caveat the number; the public docs
    // page states the freeze instead. So this flag is the invariant, and
    // flipping it has to be a product decision rather than a passing edit.
    assert.equal(bot.CREDITS_SPENDABLE, false);
  });
});

/**
 * lib/inviteCredits.js and web/lib/inviteCredits.ts are a deliberate mirror: the
 * web bundle cannot reach into the bot package. Mirrors drift, so pin them.
 */
describe('bot and site agree on the rule', () => {
  it('shares the rate and the freeze', () => {
    assert.equal(web.CREDIT_PER_COUNTED_INVITE, bot.CREDIT_PER_COUNTED_INVITE);
    assert.equal(web.CREDITS_SPENDABLE, bot.CREDITS_SPENDABLE);
  });

  it('gives the same answer for every vector', () => {
    for (const v of VECTORS) {
      assert.equal(
        web.creditsForCounted(v),
        bot.creditsForCounted(v),
        `drift on ${JSON.stringify(v)}`
      );
    }
  });
});
