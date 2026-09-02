/**
 * Paste-first pay: the two-message way to pay a merchant.
 *
 *   622 412 799        -> "That is @ludarep. How much?"
 *   0.01               -> full transfer preview -> CONFIRM
 *
 * This is the only send path that needs no verb, which is the whole point of
 * it: the product's measured problem is not policy, it is that people have to
 * know what to type. The gesture is the one they already know from a bank --
 * enter the number, read the name back, then say how much.
 *
 * What these tests defend is mostly the *edges*, because the happy path is two
 * lookups and a handler call. The edges are where a paste-first entry goes
 * wrong: a bare number that is not a code must not be swallowed, and a bare
 * amount must mean nothing unless a question is actually open.
 *
 * Run: node --test test/pastePay.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseBarePayCode, parseBareAmount, isFlizyCommandBody } = require('../lib/commands/parse');
const { PAY_CODE_LENGTH, mintPayCode } = require('../lib/payCode');

describe('a pay code pasted on its own', () => {
  it('is recognised bare, grouped, or hyphenated', () => {
    // The sheet prints it grouped, so that is what gets typed back.
    for (const t of ['622412799', '622 412 799', '622-412-799']) {
      assert.deepEqual(parseBarePayCode(t), { code: '622412799' }, t);
    }
  });

  it('normalises the grouping away, so one form reaches every lookup', () => {
    assert.equal(parseBarePayCode('622 412 799').code, parseBarePayCode('622412799').code);
  });

  it('accepts any real minted code', () => {
    for (let i = 0; i < 20; i += 1) {
      const code = mintPayCode();
      assert.deepEqual(parseBarePayCode(code), { code }, code);
    }
  });

  it('refuses anything that is not exactly a code', () => {
    // A paste-first entry that guesses is worse than one that stays quiet: this
    // must never swallow an amount, a phone number or an order reference.
    for (const t of [
      '62241279', // eight
      '6224127990', // ten -- a phone, not a code
      '622 412 79', // short group
      '622412799 0.01', // code plus something
      'pay 622412799', // has a verb, handled elsewhere
      '0.01',
      '2348012345678',
      '',
      'ludarep',
    ]) {
      assert.equal(parseBarePayCode(t), null, `${JSON.stringify(t)} should not parse`);
    }
  });

  it('wakes the bot, so it works prefixed on WhatsApp and bare on Telegram', () => {
    // WhatsApp keeps the flizy prefix, so the gesture there is
    // "flizy 622412799"; Telegram takes the bare paste. Both route through the
    // same gate, and this is what puts a bare code through it.
    assert.equal(isFlizyCommandBody('622412799'), true);
    assert.equal(isFlizyCommandBody('622 412 799'), true);
    assert.equal(isFlizyCommandBody('62241279'), false, 'a non-code number must not wake it');
  });
});

describe('the amount reply', () => {
  it('reads a bare amount, defaulting to ETH', () => {
    assert.deepEqual(parseBareAmount('0.01'), { amountEth: '0.01', asset: 'ETH' });
    assert.deepEqual(parseBareAmount('10'), { amountEth: '10', asset: 'ETH' });
  });

  it('reads an asset when one is given', () => {
    assert.deepEqual(parseBareAmount('10 FLZ'), { amountEth: '10', asset: 'FLZ' });
    assert.deepEqual(parseBareAmount('0.5 flz'), { amountEth: '0.5', asset: 'FLZ' });
  });

  it('is not a command on its own', () => {
    // It only means anything while "how much?" is open. If a bare number ever
    // starts waking the bot by itself, WhatsApp chatter becomes commands.
    assert.equal(isFlizyCommandBody('0.01'), false);
    assert.equal(isFlizyCommandBody('10 FLZ'), false);
  });

  it('refuses anything that is not just an amount', () => {
    for (const t of ['0.01 to john', 'send 0.01', 'abc', '', '0.01 FLZ extra']) {
      assert.equal(parseBareAmount(t), null, `${JSON.stringify(t)} should not parse`);
    }
  });
});

/**
 * A pasted code and a pasted amount can both be digits, so the order the router
 * tries them in decides what a second code means mid-flow. It has to mean "I
 * picked the wrong person", not "send six hundred million ETH".
 */
describe('a code and an amount are told apart by shape', () => {
  it('a real code parses as both, which is why the router checks code first', () => {
    const code = mintPayCode();
    assert.notEqual(parseBarePayCode(code), null);
    assert.notEqual(parseBareAmount(code), null, 'still amount-shaped, hence the ordering');
  });

  it('an ordinary amount is never mistaken for a code', () => {
    for (const t of ['0.01', '10', '0.5', '100']) {
      assert.equal(parseBarePayCode(t), null, t);
    }
  });

  it('the code length is what separates them from phone numbers', () => {
    // Nine digits sits below the phone floor. If that ever changes, a pasted
    // code starts opening escrow holds instead of paying merchants.
    assert.equal(PAY_CODE_LENGTH, 9);
    assert.equal(parseBarePayCode('2348012345678'), null, 'a phone is not a code');
  });
});
