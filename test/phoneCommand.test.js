/**
 * Chat accepts spaces and dashes on an international number, and refuses to
 * guess when the country code is missing. A Flizy number stays a Flizy number.
 *
 * Run: node --test test/phoneCommand.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseSendCommand,
  parseRequestCommand,
  parseNftSendCommand,
  parseCreditCommand,
} = require('../lib/commands/parse');
const { canonicalizeCommand } = require('../lib/commandAliases');

const E164 = '2347080437343';

describe('send to a phone', () => {
  const forms = [
    'send 0.01 ETH to +234 708 043 7343',
    'send 0.01 ETH to +234-708-043-7343',
    'send 0.01 ETH to +2347080437343',
    'send 0.01 to +234 708 043 7343',
  ];

  it('resolves spaced, dashed and tight forms to one number', () => {
    for (const form of forms) {
      const parsed = parseSendCommand(form);
      assert.equal(parsed.isPhone, true, form);
      assert.equal(parsed.toRaw, E164, form);
      assert.equal(parsed.phoneNeedsCountry, undefined, form);
    }
  });

  it('keeps a bare international number that was already digits', () => {
    const parsed = parseSendCommand('send 0.01 to 2348012345678');
    assert.equal(parsed.isPhone, true);
    assert.equal(parsed.toRaw, '2348012345678');
  });

  it('marks a national number and keeps the trunk zero for the question', () => {
    for (const form of ['send 0.01 ETH to 07080437343', 'send 0.01 to 0708 043 7343']) {
      const parsed = parseSendCommand(form);
      assert.equal(parsed.isPhone, true, form);
      assert.equal(parsed.phoneNeedsCountry, true, form);
      assert.equal(parsed.nationalDigits, '7080437343', form);
      assert.match(parsed.toRaw, /^0/, form);
    }
  });

  it('sends a listed token to the same phone', () => {
    const parsed = parseSendCommand('send 10 FLZ to +234 708 043 7343');
    assert.equal(parsed.asset, 'FLZ');
    assert.equal(parsed.isPhone, true);
    assert.equal(parsed.toRaw, E164);
  });

  it('does not steal a platform send or a Flizy number', () => {
    const platform = parseSendCommand('send 10 FLZ to 123456789012345678 on discord');
    assert.equal(platform.platform, 'discord');
    assert.equal(platform.isPhone, false);

    const code = parseSendCommand('send 0.01 to 012345678');
    assert.equal(code.isPhone, false);
    assert.equal(code.toRaw, '012345678');

    const grouped = parseSendCommand('send 0.01 to 012 345 678');
    assert.equal(grouped.isPhone, false);
    assert.equal(grouped.toRaw, '012345678');
  });
});

describe('request and nft send', () => {
  it('requests the same three spellings', () => {
    for (const form of [
      'request 0.01 from +234 708 043 7343',
      'request 0.01 from +234-708-043-7343',
      'request 0.01 from +2347080437343',
    ]) {
      const parsed = parseRequestCommand(form);
      assert.equal(parsed.kind, 'phone', form);
      assert.equal(parsed.fromRaw, E164, form);
      assert.equal(parsed.phoneNeedsCountry, false, form);
    }
  });

  it('requests a national number as a country question', () => {
    const parsed = parseRequestCommand('request 0.01 from 07080437343');
    assert.equal(parsed.kind, 'phone');
    assert.equal(parsed.phoneNeedsCountry, true);
    assert.equal(parsed.nationalDigits, '7080437343');
    assert.equal(parsed.fromRaw, '07080437343');
  });

  it('sends an NFT to the normalized phone', () => {
    const parsed = parseNftSendCommand('nft send giwaforge 1 to +234 708 043 7343');
    assert.equal(parsed.isNft, true);
    assert.equal(parsed.isPhone, true);
    assert.equal(parsed.toRaw, E164);
  });
});

describe('loose wording still reaches the phone parser', () => {
  it('keeps the spaces when pay is rewritten to send', () => {
    const body = canonicalizeCommand('pay 0.01 ETH to +234 708 043 7343');
    const parsed = parseSendCommand(body);
    assert.equal(parsed.toRaw, E164);
    assert.equal(parsed.isPhone, true);
  });

  it('does not turn a grouped Flizy number into a phone', () => {
    const body = canonicalizeCommand('pay 012 345 678 0.01');
    const parsed = parseSendCommand(body);
    assert.equal(parsed.isPhone, false);
    assert.equal(parsed.toRaw, '012345678');
  });
});

describe('admin credit', () => {
  it('still takes a digit id, and a national number reaches the handler intact', () => {
    assert.equal(parseCreditCommand('credit 2347080437343 0.01').phone, '2347080437343');
    assert.equal(parseCreditCommand('credit 123456 0.01').phone, '123456');
    assert.equal(parseCreditCommand('credit 07080437343 0.01').phone, '07080437343');
    assert.equal(parseCreditCommand('credit +234 708 043 7343 0.01'), null);
  });
});
