/**
 * Email claim addressing + parse send to email.
 * Run: node --test test/emailClaim.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEmail,
  isValidEmail,
  parseEmail,
  maskEmail,
} = require('../lib/email');
const {
  emailRecipient,
  recipientColumns,
  recipientFromRow,
  claimMatchesRecipient,
  recipientKeys,
  claimRecipientLabel,
  publicRecipientLabel,
} = require('../lib/claimRecipient');
const { parseSendCommand } = require('../lib/router');
const { buildClaimPlan, formatClaimPlanPreview } = require('../lib/engine/plan');
const { createSendIntent } = require('../lib/engine/intent');

describe('email helpers', () => {
  it('normalizes and validates', () => {
    assert.equal(normalizeEmail('  Alice@Example.COM '), 'alice@example.com');
    assert.equal(isValidEmail('alice@example.com'), true);
    assert.equal(isValidEmail('not-an-email'), false);
    assert.equal(parseEmail('Bob@x.io'), 'bob@x.io');
    assert.match(maskEmail('alice@example.com'), /@example\.com$/);
  });
});

describe('email claim recipient', () => {
  it('stores to_email only', () => {
    const r = emailRecipient('You@Domain.com');
    assert.equal(r.kind, 'email');
    assert.equal(r.email, 'you@domain.com');
    const cols = recipientColumns(r);
    assert.equal(cols.to_email, 'you@domain.com');
    assert.equal(cols.to_wa_hint, null);
    assert.equal(cols.to_channel, null);
    assert.equal(cols.to_external_id, null);
  });

  it('matches registration email keys', () => {
    const row = { to_email: 'you@domain.com', to_wa_hint: null, to_channel: null };
    const keys = recipientKeys({ emails: ['you@domain.com'] });
    assert.equal(claimMatchesRecipient(row, keys), true);
    assert.equal(
      claimMatchesRecipient(row, recipientKeys({ emails: ['other@domain.com'] })),
      false
    );
    assert.equal(claimMatchesRecipient(row, recipientKeys({ phones: ['2348012345678'] })), false);
  });

  it('labels for plan vs public', () => {
    const r = emailRecipient('alice@example.com');
    assert.equal(claimRecipientLabel(r), 'alice@example.com');
    assert.equal(publicRecipientLabel({ to_email: 'alice@example.com' }), 'a…@example.com');
  });

  it('round-trips from row', () => {
    const r = recipientFromRow({ to_email: 'x@y.z', to_channel: null, to_wa_hint: null });
    assert.equal(r.kind, 'email');
    assert.equal(r.email, 'x@y.z');
  });
});

describe('parseSendCommand email', () => {
  it('parses bare email destination', () => {
    const a = parseSendCommand('send 0.001 to friend@email.com');
    assert.equal(a.isEmail, true);
    assert.equal(a.toRaw, 'friend@email.com');
    assert.equal(a.isPhone, false);
    assert.equal(a.platform, null);
  });

  it('parses email: prefix and eth word', () => {
    const a = parseSendCommand('send 0.01 eth to email:Friend@Email.COM');
    assert.equal(a.isEmail, true);
    assert.equal(a.toRaw, 'friend@email.com');
  });

  it('does not steal platform or phone forms', () => {
    assert.equal(parseSendCommand('send 0.001 to @user on telegram').isEmail, undefined);
    assert.equal(parseSendCommand('send 0.001 to 2348012345678').isPhone, true);
  });
});

describe('telegram pending-by-username claim', () => {
  const {
    telegramPendingUsernameRecipient,
    claimMatchesRecipient,
    recipientKeys,
    isTelegramPendingUsernameId,
  } = require('../lib/claimRecipient');

  it('builds tguser: external id from handle', () => {
    const r = telegramPendingUsernameRecipient('Ludareq');
    assert.equal(r.channel, 'telegram');
    assert.equal(r.externalId, 'tguser:ludareq');
    assert.equal(r.displayHandle, 'Ludareq');
    assert.equal(isTelegramPendingUsernameId(r.externalId), true);
  });

  it('matches when linked telegram has that display_handle', () => {
    const row = {
      to_channel: 'telegram',
      to_external_id: 'tguser:ludareq',
      to_display_handle: 'Ludareq',
    };
    const keys = recipientKeys({
      identities: [
        {
          channel: 'telegram',
          external_id: '999888777',
          display_handle: 'ludareq',
        },
      ],
    });
    assert.equal(claimMatchesRecipient(row, keys), true);
  });

  it('does not match a different handle', () => {
    const row = {
      to_channel: 'telegram',
      to_external_id: 'tguser:ludareq',
      to_display_handle: 'Ludareq',
    };
    const keys = recipientKeys({
      identities: [
        {
          channel: 'telegram',
          external_id: '999888777',
          display_handle: 'ludarep',
        },
      ],
    });
    assert.equal(claimMatchesRecipient(row, keys), false);
  });
});

describe('email claim plan preview', () => {
  it('warns about typos and signup', () => {
    const intent = createSendIntent({
      actor: {
        accountId: 'a1',
        waSenderId: '2348000000000',
        isAdmin: false,
        sessionUnlocked: true,
        hasPin: false,
      },
      amountEth: '0.01',
      toLabel: 'friend@email.com',
    });
    const plan = buildClaimPlan({
      intent,
      policy: { decision: 'ALLOW_WITH_CONFIRM' },
      chain: { chainId: 91342, chainName: 'GIWA Sepolia', nativeSymbol: 'ETH' },
      fromAddress: '0x3333333333333333333333333333333333333333',
      recipient: emailRecipient('friend@email.com'),
      fromBalanceEth: '1',
    });
    assert.equal(plan.input.recipientKind, 'email');
    const preview = formatClaimPlanPreview(plan);
    assert.match(preview, /friend@email\.com/);
    assert.match(preview, /mistyped|carefully/i);
    assert.match(preview, /email/i);
  });
});
