/**
 * Amount parsing: the shapes people actually type.
 *
 * Three separate failures were measured before this existed. `send 10,000 to
 * john` did not parse at all, which on WhatsApp means the bot says nothing —
 * the same silent-drop shape as the bare `save` bug. `send ₦10,000` and
 * `send $10` did the same. And `send 10000 to john` parsed as ten thousand
 * ETH, then got refused by a cap the user was never thinking about.
 *
 * What is protected here: grouping parses, malformed grouping does not, a
 * currency we cannot price gets words instead of silence, and a bare amount
 * that was obviously not ETH says so.
 *
 * Run: node --test test/amountParsing.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAmount,
  detectUnsupportedCurrency,
  looksLikeNonEthAmount,
} = require('../lib/commands/amount');
const {
  parseSendCommand,
  parseBareAmount,
  parseBarePayCode,
  parsePayAskCommand,
  parseSwapCommand,
  parseRequestCommand,
} = require('../lib/commands/parse');

describe('normalizeAmount', () => {
  it('strips real grouping', () => {
    assert.equal(normalizeAmount('10,000'), '10000');
    assert.equal(normalizeAmount('1,234.56'), '1234.56');
    assert.equal(normalizeAmount('1,234,567'), '1234567');
  });

  it('leaves an ungrouped amount exactly as typed', () => {
    // Strings, not numbers: these reach ethers.parseEther, and a float round
    // trip is how a wei-level rounding bug gets in.
    assert.equal(normalizeAmount('0.01'), '0.01');
    assert.equal(normalizeAmount('.5'), '.5');
    assert.equal(normalizeAmount('10000'), '10000');
  });

  it('refuses grouping that is not grouping', () => {
    for (const bad of ['1,23', '1,,2', '10,0000', ',5', '1,2,3']) {
      assert.equal(normalizeAmount(bad), null, `accepted ${bad}`);
    }
  });

  it('refuses anything with no digit in it', () => {
    for (const bad of ['', '   ', '.', ',', null, undefined]) {
      assert.equal(normalizeAmount(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe('currency we cannot price', () => {
  it('names naira and dollars when they are attached to a number', () => {
    assert.equal(detectUnsupportedCurrency('send ₦10,000 to john'), 'Naira');
    assert.equal(detectUnsupportedCurrency('send NGN 5000 to john'), 'Naira');
    assert.equal(detectUnsupportedCurrency('send N5000 to john'), 'Naira');
    assert.equal(detectUnsupportedCurrency('send $10 to john'), 'Dollar');
    assert.equal(detectUnsupportedCurrency('send USD 10 to john'), 'Dollar');
  });

  it('ignores a mention with no number on it', () => {
    assert.equal(detectUnsupportedCurrency('what is naira'), null);
    assert.equal(detectUnsupportedCurrency('send 0.01 to john'), null);
    assert.equal(detectUnsupportedCurrency('send 10 flz to nathan'), null);
  });
});

describe('a bare amount that was not meant as ETH', () => {
  it('is judged against the ceiling, not the cap', () => {
    assert.equal(looksLikeNonEthAmount('10000', 1), true);
    assert.equal(looksLikeNonEthAmount('1', 1), true);
    assert.equal(looksLikeNonEthAmount('0.5', 1), false);
    assert.equal(looksLikeNonEthAmount('0.01', 1), false);
  });

  it('never fires on something that is not a number', () => {
    assert.equal(looksLikeNonEthAmount('abc', 1), false);
    assert.equal(looksLikeNonEthAmount(null, 1), false);
    assert.equal(looksLikeNonEthAmount('10000', NaN), false);
  });
});

describe('send parses the shapes people type', () => {
  it('takes grouped amounts', () => {
    assert.equal(parseSendCommand('send 10,000 to john').amountEth, '10000');
    assert.equal(parseSendCommand('send 1,234.56 to john').amountEth, '1234.56');
    assert.equal(parseSendCommand('send 10,000 FLZ to john').amountEth, '10000');
  });

  it('still takes everything it took before', () => {
    assert.equal(parseSendCommand('send 0.01 to john').amountEth, '0.01');
    assert.equal(parseSendCommand('send .5 to john').amountEth, '.5');
    assert.equal(parseSendCommand('send 0.01 eth to john').amountEth, '0.01');
    assert.equal(parseSendCommand('send 10 FLZ to john').asset, 'FLZ');
  });

  it('fails the whole parse on malformed grouping', () => {
    assert.equal(parseSendCommand('send 1,23 to john'), null);
    assert.equal(parseSendCommand('send 1,,2 to john'), null);
  });

  it('reports whether an asset was named', () => {
    assert.equal(parseSendCommand('send 1 to john').assetExplicit, false);
    assert.equal(parseSendCommand('send 10000 to john').assetExplicit, false);
    assert.equal(parseSendCommand('send 1 eth to john').assetExplicit, true);
    assert.equal(parseSendCommand('send 10 flz to john').assetExplicit, true);
  });
});

describe('the other amount parsers got the same treatment', () => {
  it('bare amount, pay-for, swap and request all take grouping', () => {
    assert.equal(parseBareAmount('10,000').amountEth, '10000');
    assert.equal(parseBareAmount('10,000 FLZ').asset, 'FLZ');
    assert.equal(parsePayAskCommand('pay 1,000 for rent').amountEth, '1000');
    assert.equal(parseSwapCommand('buy 10,000 flz').amount, '10000');
    assert.equal(parseRequestCommand('request 1,500 from john').amountEth, '1500');
  });

  it('and reject malformed grouping the same way', () => {
    assert.equal(parseBareAmount('1,23'), null);
    assert.equal(parseSwapCommand('buy 1,23 flz'), null);
  });
});

/**
 * The widened character class runs through every amount capture in the parser,
 * so the things that live next to an amount are what to check for collateral
 * damage.
 */
describe('nothing else moved', () => {
  it('a pay code is still a pay code, not an amount', () => {
    assert.deepEqual(parseBarePayCode('123 456 789'), { code: '123456789' });
    assert.equal(parseBarePayCode('10,000'), null);
  });

  it('a note keeps its own commas, verbatim', () => {
    // The alternative design -- rewriting grouped numbers across the whole
    // input before parsing -- would have turned this into "order 1234".
    assert.equal(parsePayAskCommand('pay 0.01 for order 1,234').note, 'order 1,234');
  });

  it('a phone recipient is untouched', () => {
    const r = parseSendCommand('send 0.01 to 2348012345678');
    assert.equal(r.toRaw, '2348012345678');
    assert.equal(r.isPhone, true);
  });
});
