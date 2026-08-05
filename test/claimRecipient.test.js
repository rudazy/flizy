/**
 * Who a claim is held for, and who is allowed to be paid it.
 *
 * A claim is addressed either to a phone or to a platform identity, and the two
 * never bleed into each other. The tests that matter most here are the negative
 * ones: the same numeric id on a different channel is a different person, and a
 * phone is not a platform id. External ids are numeric everywhere, so the only
 * thing keeping those apart is that the channel is compared too.
 *
 * Run: node --test test/claimRecipient.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  phoneRecipient,
  platformRecipient,
  recipientFromRow,
  recipientColumns,
  claimRecipientLabel,
  publicRecipientLabel,
  recipientKeys,
  claimMatchesRecipient,
  channelLabel,
} = require('../lib/claimRecipient');

const PHONE = '2348012345678';
const GH_ID = '583231';
const X_ID = '12345678';

const phoneClaim = { to_wa_hint: PHONE, to_channel: null, to_external_id: null };
const githubClaim = {
  to_wa_hint: null,
  to_channel: 'github',
  to_external_id: GH_ID,
  to_display_handle: 'jack',
};

describe('phoneRecipient', () => {
  it('normalizes a phone into the claim key', () => {
    assert.deepEqual(phoneRecipient(`+${PHONE}`), { kind: 'phone', phone: PHONE });
  });

  it('refuses anything that is not a phone', () => {
    assert.throws(() => phoneRecipient('jack'), /Invalid phone/);
    assert.throws(() => phoneRecipient(''), /Invalid phone/);
    assert.throws(() => phoneRecipient('123'), /Invalid phone/);
  });
});

describe('platformRecipient', () => {
  it('binds to the channel and the immutable id', () => {
    const r = platformRecipient('github', GH_ID, 'jack');
    assert.equal(r.kind, 'platform');
    assert.equal(r.channel, 'github');
    assert.equal(r.externalId, GH_ID);
    assert.equal(r.displayHandle, 'jack');
  });

  it('keeps the handle out of the id, since handles get reassigned', () => {
    assert.throws(() => platformRecipient('github', '@jack'), /numeric user id, not the handle/);
    // The dangerous one: a bare handle looks like a perfectly good string.
    assert.throws(() => platformRecipient('github', 'jack'), /numeric user id, not the handle/);
    assert.throws(() => platformRecipient('x', 'jack_123'), /numeric user id, not the handle/);
  });

  it('stores the handle without its leading at sign', () => {
    assert.equal(platformRecipient('x', X_ID, '@jack').displayHandle, 'jack');
  });

  it('has no handle rather than a made up one', () => {
    assert.equal(platformRecipient('x', X_ID).displayHandle, null);
  });

  it('refuses a channel the system does not know', () => {
    assert.throws(() => platformRecipient('signal', '123'), /unknown channel/i);
  });

  it('refuses an empty id', () => {
    assert.throws(() => platformRecipient('github', ''), /needs the recipient user id/);
  });
});

describe('recipientColumns', () => {
  it('populates exactly one addressing mode for a phone', () => {
    const cols = recipientColumns(phoneRecipient(PHONE));
    assert.equal(cols.to_wa_hint, PHONE);
    assert.equal(cols.to_channel, null);
    assert.equal(cols.to_external_id, null);
  });

  it('populates exactly one addressing mode for a platform', () => {
    const cols = recipientColumns(platformRecipient('github', GH_ID, 'jack'));
    assert.equal(cols.to_wa_hint, null);
    assert.equal(cols.to_channel, 'github');
    assert.equal(cols.to_external_id, GH_ID);
    assert.equal(cols.to_display_handle, 'jack');
  });

  it('refuses to build a row with no recipient', () => {
    assert.throws(() => recipientColumns(null), /needs a recipient/);
  });
});

describe('recipientFromRow', () => {
  it('reads a phone claim back', () => {
    assert.deepEqual(recipientFromRow(phoneClaim), { kind: 'phone', phone: PHONE });
  });

  it('reads a platform claim back', () => {
    const r = recipientFromRow(githubClaim);
    assert.equal(r.kind, 'platform');
    assert.equal(r.channel, 'github');
    assert.equal(r.externalId, GH_ID);
  });

  it('is null when a row addresses nobody', () => {
    assert.equal(recipientFromRow({ to_wa_hint: null, to_channel: null }), null);
    assert.equal(recipientFromRow(null), null);
  });
});

describe('claimMatchesRecipient', () => {
  it('pays a platform claim to the same identity', () => {
    const keys = recipientKeys({ identities: [{ channel: 'github', external_id: GH_ID }] });
    assert.equal(claimMatchesRecipient(githubClaim, keys), true);
  });

  it('pays a telegram claim only after that telegram user id is linked', () => {
    const tgClaim = {
      to_wa_hint: null,
      to_channel: 'telegram',
      to_external_id: '9988776655',
      to_display_handle: 'alice_crypto',
    };
    assert.equal(
      claimMatchesRecipient(
        tgClaim,
        recipientKeys({ identities: [{ channel: 'telegram', external_id: '9988776655' }] })
      ),
      true
    );
    // Same handle is irrelevant — id must match (username reassignment).
    assert.equal(
      claimMatchesRecipient(
        tgClaim,
        recipientKeys({ identities: [{ channel: 'telegram', external_id: '1111111111' }] })
      ),
      false
    );
    // Unlinked (or only other platforms): no payout.
    assert.equal(
      claimMatchesRecipient(
        tgClaim,
        recipientKeys({ identities: [{ channel: 'github', external_id: GH_ID }] })
      ),
      false
    );
  });

  it('refuses the same id on a different channel', () => {
    // The collision this whole design exists to prevent. Platform ids are
    // numeric everywhere, so the same digits are a real person on each one.
    const keys = recipientKeys({ identities: [{ channel: 'x', external_id: GH_ID }] });
    assert.equal(claimMatchesRecipient(githubClaim, keys), false);
  });

  it('refuses a different id on the right channel', () => {
    const keys = recipientKeys({ identities: [{ channel: 'github', external_id: '999999' }] });
    assert.equal(claimMatchesRecipient(githubClaim, keys), false);
  });

  it('never pays a platform claim to a phone', () => {
    const keys = recipientKeys({ phones: [PHONE] });
    assert.equal(claimMatchesRecipient(githubClaim, keys), false);
  });

  it('never pays a phone claim to a platform identity', () => {
    // Even when the platform id is exactly the phone digits.
    const keys = recipientKeys({ identities: [{ channel: 'github', external_id: PHONE }] });
    assert.equal(claimMatchesRecipient(phoneClaim, keys), false);
  });

  it('pays a phone claim to a matching phone', () => {
    const keys = recipientKeys({ phones: [`+${PHONE}`] });
    assert.equal(claimMatchesRecipient(phoneClaim, keys), true);
  });

  it('matches nothing when the recipient has proven no identity at all', () => {
    const keys = recipientKeys({});
    assert.equal(claimMatchesRecipient(phoneClaim, keys), false);
    assert.equal(claimMatchesRecipient(githubClaim, keys), false);
  });

  it('finds the right claim among several proven identities', () => {
    const keys = recipientKeys({
      phones: [PHONE],
      identities: [
        { channel: 'telegram', external_id: '55667788' },
        { channel: 'github', external_id: GH_ID },
      ],
    });
    assert.equal(claimMatchesRecipient(githubClaim, keys), true);
    assert.equal(claimMatchesRecipient(phoneClaim, keys), true);
  });
});

describe('recipientKeys', () => {
  it('drops identities on a channel it cannot name', () => {
    const keys = recipientKeys({
      identities: [
        { channel: 'signal', external_id: '123' },
        { channel: 'github', external_id: GH_ID },
      ],
    });
    assert.deepEqual(keys.identities, [
      { channel: 'github', externalId: GH_ID, displayHandle: null },
    ]);
  });

  it('drops blank ids and implausible phones', () => {
    const keys = recipientKeys({
      phones: ['', '123', null],
      identities: [{ channel: 'github', external_id: '  ' }],
    });
    assert.deepEqual(keys.phones, []);
    assert.deepEqual(keys.identities, []);
  });

  it('deduplicates', () => {
    const keys = recipientKeys({
      phones: [PHONE, `+${PHONE}`],
      identities: [
        { channel: 'github', external_id: GH_ID },
        { channel: 'github', external_id: GH_ID },
      ],
    });
    assert.equal(keys.phones.length, 1);
    assert.equal(keys.identities.length, 1);
  });
});

describe('labels', () => {
  it('names a phone claim the way it always did', () => {
    assert.equal(claimRecipientLabel(phoneClaim), `+${PHONE}`);
  });

  it('names a platform claim by handle and platform', () => {
    assert.equal(claimRecipientLabel(githubClaim), '@jack (GitHub)');
  });

  it('falls back to the id rather than inventing a handle', () => {
    const label = claimRecipientLabel({ to_channel: 'x', to_external_id: X_ID });
    assert.equal(label, `X user ${X_ID}`);
  });

  it('flattens a handle that tries to forge a confirm line', () => {
    // The same defence the pay-request requester label carries. A newline here
    // would let a handle add its own "Amount:" line to a plan preview.
    const label = claimRecipientLabel({
      to_channel: 'github',
      to_external_id: GH_ID,
      to_display_handle: 'jack\nAmount:  99 ETH',
    });
    assert.ok(!label.includes('\n'), 'label must be a single line');
    assert.ok(label.includes('jack'));
  });

  it('names every channel it supports', () => {
    assert.equal(channelLabel('whatsapp'), 'WhatsApp');
    assert.equal(channelLabel('telegram'), 'Telegram');
    assert.equal(channelLabel('x'), 'X');
    assert.equal(channelLabel('github'), 'GitHub');
    assert.equal(channelLabel('discord'), 'Discord');
  });
});

describe('publicRecipientLabel', () => {
  it('masks a phone to the last four', () => {
    assert.equal(publicRecipientLabel(phoneClaim), `...${PHONE.slice(-4)}`);
  });

  it('shows the handle so the recipient recognizes the claim', () => {
    assert.equal(publicRecipientLabel(githubClaim), '@jack (GitHub)');
  });

  it('never puts the raw platform id on a public page', () => {
    const label = publicRecipientLabel({ to_channel: 'x', to_external_id: X_ID });
    assert.ok(!label.includes(X_ID), 'the numeric id must not be exposed');
    assert.equal(label, 'a X user');
  });
});
