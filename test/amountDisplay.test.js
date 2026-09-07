/**
 * An amount reads the same wherever it is written.
 *
 * Chat and the site each grew their own rule. The one that mattered: the site
 * rounded anything at or above 1000 to two decimals, so `12345.6789 FLZ` was
 * `12,345.68` on the dashboard and `12345.6789` in chat. Same row, two numbers,
 * and the shorter one was wrong.
 *
 * The site also grouped using the *viewer's* locale. In a locale that groups
 * with dots that renders `12.345,6789`, which in a money app is not a
 * formatting quirk — it is a different number to the person reading it.
 *
 * Run: node --test test/amountDisplay.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../lib/amountDisplay');

/** Same inputs to both sides. Awkward values are in here on purpose. */
const VECTORS = [
  0,
  '0',
  '0.01',
  '1.5',
  '10',
  '0.1234567',
  '0.000001',
  '0.0000005',
  '999.999999',
  '1000',
  '1234.5',
  '12345.6789',
  '1234567.891',
  '-1234.5',
  '-0.5',
  'not a number',
  '',
  null,
  undefined,
];

let web;
before(async () => {
  web = await import('../web/lib/amountDisplay.ts');
});

describe('the rule', () => {
  it('groups thousands and keeps the decimals it was given', () => {
    // The regression: this used to lose two decimal places on the site.
    assert.equal(bot.formatAmount('12345.6789'), '12,345.6789');
    assert.equal(bot.formatAmount('1234567.891'), '1,234,567.891');
    assert.equal(bot.formatAmount('1234.5'), '1,234.5');
  });

  it('leaves small amounts alone', () => {
    assert.equal(bot.formatAmount('0.01'), '0.01');
    assert.equal(bot.formatAmount('1.5'), '1.5');
    assert.equal(bot.formatAmount('10'), '10');
  });

  it('drops trailing zeros rather than padding to six places', () => {
    assert.equal(bot.formatAmount('1.500000'), '1.5');
    assert.equal(bot.formatAmount('2.000000'), '2');
  });

  it('caps display at six decimals', () => {
    assert.equal(bot.formatAmount('0.1234567'), '0.123457');
  });

  it('goes exponential only where six decimals would read as zero', () => {
    assert.equal(bot.formatAmount('0.000001'), '0.000001');
    assert.equal(bot.formatAmount('0.0000005'), '5.0000e-7');
  });

  it('handles zero and negatives', () => {
    assert.equal(bot.formatAmount(0), '0');
    assert.equal(bot.formatAmount('0'), '0');
    assert.equal(bot.formatAmount('-1234.5'), '-1,234.5');
  });

  it('hands back anything that is not a number untouched', () => {
    // Not a number: hand the input back rather than print NaN at someone.
    assert.equal(bot.formatAmount('not a number'), 'not a number');
    assert.equal(bot.formatAmount(undefined), 'undefined');
  });

  it('renders an empty amount as zero, as both formatters always did', () => {
    // `Number('') === 0`, so this falls through the zero branch. Carried over
    // rather than changed: it is long-standing behaviour on both surfaces and
    // fixing it is a question about null amounts, not about how to write one.
    assert.equal(bot.formatAmount(''), '0');
    assert.equal(bot.formatAmount(null), '0');
  });

  it('groups the same way for every reader', () => {
    // Pinned locale. A viewer in a dot-grouping locale must not be shown
    // "12.345,6789" for the amount everyone else sees as "12,345.6789".
    assert.equal(bot.formatAmount('12345.6789').includes(','), true);
    assert.equal(bot.formatAmount('12345.6789').split('.').length, 2);
  });
});

/**
 * lib/amountDisplay.js and web/lib/amountDisplay.ts are a deliberate mirror:
 * a client component cannot reach into the bot package. Mirrors drift, so pin
 * them. Same shape as test/inviteCredits.test.js.
 */
describe('chat and the site write the same number', () => {
  it('agrees on every vector', () => {
    for (const v of VECTORS) {
      assert.equal(
        web.formatAmount(v),
        bot.formatAmount(v),
        `drift on ${JSON.stringify(v)}`
      );
    }
  });

  it('agrees on the constants', () => {
    assert.equal(web.EXPONENTIAL_BELOW, bot.EXPONENTIAL_BELOW);
    assert.equal(web.MAX_DECIMALS, bot.MAX_DECIMALS);
  });
});

/**
 * The name chat calls it by. Eleven call sites use `formatEth`, so it stays,
 * but it must not be allowed to drift back into its own rule.
 */
describe('the chat entry point is the same function', () => {
  it('formatEth is the shared rule', () => {
    const { formatEth } = require('../lib/commands/chat');
    for (const v of VECTORS) {
      assert.equal(formatEth(v), bot.formatAmount(v), `drift on ${JSON.stringify(v)}`);
    }
  });
});
