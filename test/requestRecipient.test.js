/**
 * A request reaches whoever a send reaches.
 *
 * Until now `handleRequestMoney` refused anything that was not a phone —
 * "Requests work by phone number so the payer sees them after linking" — while
 * a send had reached usernames, platforms and email since the Stage 1 identity
 * work. Requests never caught up, so `payment_requests` had one recipient
 * column.
 *
 * That is the blocker under split bill: splitting four ways means asking four
 * people you know as `@ada`, not as `2348012345678`.
 *
 * What is protected here: each target shape resolves to exactly one addressing
 * mode, the modes never overlap, and a request addressed to a platform id is
 * never handed to somebody who merely shares the handle.
 *
 * Run: node --test test/requestRecipient.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseRequestCommand } = require('../lib/commands/parse');
const {
  phoneRecipient,
  emailRecipient,
  platformRecipient,
  recipientKeys,
  claimMatchesRecipient,
} = require('../lib/claimRecipient');
const { accountRecipient } = require('../lib/paymentRequests');

describe('every shape a request can be aimed at', () => {
  it('reads a phone', () => {
    const r = parseRequestCommand('request 0.01 from 2348012345678');
    assert.equal(r.kind, 'phone');
    assert.equal(r.fromRaw, '2348012345678');
  });

  it('reads a username, with or without the @', () => {
    assert.equal(parseRequestCommand('request 0.01 from @ada').kind, 'alias');
    assert.equal(parseRequestCommand('request 0.01 from @ada').fromRaw, 'ada');
    assert.equal(parseRequestCommand('request 0.01 from ada').fromRaw, 'ada');
  });

  it('reads a platform handle both ways round', () => {
    const on = parseRequestCommand('request 0.01 from @ada on telegram');
    assert.equal(on.kind, 'platform');
    assert.equal(on.platform, 'telegram');
    assert.equal(on.fromRaw, 'ada');

    const colon = parseRequestCommand('request 0.01 from github:octocat');
    assert.equal(colon.platform, 'github');
    assert.equal(colon.fromRaw, 'octocat');
  });

  it('reads an email rather than mistaking it for a name', () => {
    const r = parseRequestCommand('request 0.01 from ada@example.com');
    assert.equal(r.kind, 'email');
    assert.equal(r.fromRaw, 'ada@example.com');
  });

  it('recognises a raw address so it can be refused by name', () => {
    // A send may move money to an address. A request has to reach a person who
    // can be told about it, so this parses only to produce a specific refusal
    // instead of falling through to "unknown command".
    const r = parseRequestCommand(
      'request 0.01 from 0x1111111111111111111111111111111111111111'
    );
    assert.equal(r.kind, 'address');
  });

  it('still takes the amount shapes the parser learned', () => {
    assert.equal(parseRequestCommand('request 1,000 from @ada').amountEth, '1000');
    assert.equal(parseRequestCommand('request 0.01 eth from @ada').fromRaw, 'ada');
    assert.equal(parseRequestCommand('request 0.01 from'), null);
  });
});

/**
 * The mapper is what guarantees a row carries exactly one address. If two were
 * ever set, both match paths would find the row and two different people would
 * each be shown a bill only one of them can pay.
 */
describe('one addressing mode, never two', () => {
  const { requestRecipientColumns } = require('../lib/paymentRequests');

  /** The recipient columns that are actually populated. */
  const modesSet = (recipient) => {
    const c = requestRecipientColumns(recipient);
    return ['from_account_id', 'from_wa_hint', 'from_channel', 'from_email'].filter(
      (k) => c[k] != null
    );
  };

  it('sets exactly one, for every shape', () => {
    const shapes = {
      account: accountRecipient('acc-1', 'ada'),
      phone: phoneRecipient('2348012345678'),
      email: emailRecipient('ada@example.com'),
      platform: platformRecipient('telegram', '55501', 'ada'),
    };
    for (const [name, recipient] of Object.entries(shapes)) {
      assert.deepEqual(
        modesSet(recipient).length,
        1,
        `${name} set ${JSON.stringify(modesSet(recipient))}`
      );
    }
  });

  it('puts each shape in its own column', () => {
    assert.equal(requestRecipientColumns(accountRecipient('acc-1')).from_account_id, 'acc-1');
    assert.equal(
      requestRecipientColumns(phoneRecipient('2348012345678')).from_wa_hint,
      '2348012345678'
    );
    assert.equal(
      requestRecipientColumns(emailRecipient('ada@example.com')).from_email,
      'ada@example.com'
    );
    const platform = requestRecipientColumns(platformRecipient('telegram', '55501', 'ada'));
    assert.equal(platform.from_channel, 'telegram');
    assert.equal(platform.from_external_id, '55501');
  });

  it('keeps the handle as display only, never as the address', () => {
    const c = requestRecipientColumns(platformRecipient('telegram', '55501', 'ada'));
    assert.equal(c.from_display_handle, 'ada');
    assert.equal(c.from_external_id, '55501');
  });

  it('refuses to build an account recipient without an account', () => {
    assert.throws(() => accountRecipient(null), /needs an account id/);
  });
});

/**
 * The reason requests address a platform by immutable id and never by handle.
 */
describe('a handle is not an address', () => {
  it('matches a platform request on the id, not the display handle', () => {
    const row = {
      to_channel: 'telegram',
      to_external_id: '55501',
      to_display_handle: 'ada',
    };

    const rightPerson = recipientKeys({
      phones: [],
      identities: [{ channel: 'telegram', external_id: '55501' }],
      emails: [],
    });
    assert.equal(claimMatchesRecipient(row, rightPerson), true);

    // Same handle, different account. Handles get renamed and reassigned; if
    // this matched, whoever picked up the name would be shown the request.
    const impostor = recipientKeys({
      phones: [],
      identities: [{ channel: 'telegram', external_id: '99999', display_handle: 'ada' }],
      emails: [],
    });
    assert.equal(claimMatchesRecipient(row, impostor), false);
  });

  it('does not match across channels on the same id', () => {
    const row = { to_channel: 'github', to_external_id: '583231' };
    const onX = recipientKeys({
      phones: [],
      identities: [{ channel: 'x', external_id: '583231' }],
      emails: [],
    });
    assert.equal(claimMatchesRecipient(row, onX), false);
  });
});
