/**
 * An unrecognized channel must never be silently treated as WhatsApp.
 *
 * normalizeChannel used to return 'whatsapp' for anything that was not
 * 'telegram'. External ids are numeric on every channel (WhatsApp LIDs,
 * Telegram user ids, and the platform ids added alongside this), so that
 * default could take one platform's id and use it as a key on another
 * platform's rows: a lookup finding the wrong account, a write binding the
 * wrong identity, or a notification delivered into a stranger's chat.
 *
 * The platform channels are recognized here, but nothing creates an identity on
 * one yet. Everything below is about what the key space accepts, not about
 * anybody being able to send or receive on those channels.
 *
 * Run: node --test test/channelKey.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHANNELS,
  KNOWN_CHANNELS,
  normalizeChannel,
  isKnownChannel,
  assertChannel,
  normalizeExternalId,
} = require('../lib/channelKey');

/** Channels that do not exist in this system, used as the negative fixtures. */
const UNKNOWN = ['signal', 'matrix', 'sms', 'email', 'whatsapp2', 'what', 'tele'];

describe('the supported channel list', () => {
  it('is exactly the list the database CHECK constraints allow', () => {
    // Kept in lockstep with 20260801120000_platform_channels.sql on
    // channel_identities, sessions and notifications. Adding a channel in code
    // without widening those three makes every write on it fail, so this test
    // is here to make the migration impossible to forget.
    assert.deepEqual(
      [...KNOWN_CHANNELS].sort(),
      ['discord', 'github', 'telegram', 'whatsapp', 'x'].sort()
    );
  });

  it('exposes every known channel as a named constant', () => {
    assert.deepEqual(Object.values(CHANNELS).sort(), [...KNOWN_CHANNELS].sort());
  });
});

describe('normalizeChannel', () => {
  it('canonicalizes the chat channels', () => {
    assert.equal(normalizeChannel('whatsapp'), CHANNELS.WHATSAPP);
    assert.equal(normalizeChannel('telegram'), CHANNELS.TELEGRAM);
  });

  it('canonicalizes the platform channels', () => {
    assert.equal(normalizeChannel('x'), CHANNELS.X);
    assert.equal(normalizeChannel('github'), CHANNELS.GITHUB);
    assert.equal(normalizeChannel('discord'), CHANNELS.DISCORD);
  });

  it('tolerates case and surrounding whitespace', () => {
    assert.equal(normalizeChannel('  WhatsApp '), CHANNELS.WHATSAPP);
    assert.equal(normalizeChannel('TELEGRAM'), CHANNELS.TELEGRAM);
    assert.equal(normalizeChannel(' GitHub '), CHANNELS.GITHUB);
  });

  it('returns null for a channel it does not know', () => {
    for (const raw of UNKNOWN) {
      assert.equal(normalizeChannel(raw), null, `${raw} should not resolve`);
    }
  });

  it('returns null for empty and missing input instead of defaulting', () => {
    assert.equal(normalizeChannel(''), null);
    assert.equal(normalizeChannel('   '), null);
    assert.equal(normalizeChannel(undefined), null);
    assert.equal(normalizeChannel(null), null);
  });

  it('regression: nothing resolves to WhatsApp but WhatsApp', () => {
    // The exact shape of the old bug. A platform id is numeric, as is a
    // WhatsApp LID, so resolving either of these to WhatsApp put them in the
    // same key space.
    for (const raw of ['x', 'github', 'discord', ...UNKNOWN]) {
      assert.notEqual(normalizeChannel(raw), CHANNELS.WHATSAPP, `${raw} must not become WhatsApp`);
    }
  });

  it('regression: a platform channel resolves to itself, not to a fallback', () => {
    assert.equal(normalizeChannel('github'), 'github');
    assert.equal(normalizeChannel('discord'), 'discord');
    assert.equal(normalizeChannel('x'), 'x');
  });
});

describe('isKnownChannel', () => {
  it('is true for every supported channel', () => {
    for (const ch of Object.values(CHANNELS)) {
      assert.equal(isKnownChannel(ch), true, `${ch} should be known`);
    }
  });

  it('is false for anything else', () => {
    for (const raw of UNKNOWN) {
      assert.equal(isKnownChannel(raw), false, `${raw} should not be known`);
    }
    assert.equal(isKnownChannel(''), false);
  });
});

describe('assertChannel', () => {
  it('returns the canonical key for a supported channel', () => {
    assert.equal(assertChannel('WhatsApp'), CHANNELS.WHATSAPP);
    assert.equal(assertChannel('telegram'), CHANNELS.TELEGRAM);
    assert.equal(assertChannel('GitHub'), CHANNELS.GITHUB);
  });

  it('throws on an unknown channel rather than picking one', () => {
    assert.throws(() => assertChannel('signal'), /unknown channel/i);
    assert.throws(() => assertChannel(''), /unknown channel/i);
    assert.throws(() => assertChannel(undefined), /unknown channel/i);
  });

  it('names the caller so the failure points at the right code', () => {
    assert.throws(() => assertChannel('signal', 'getAccountByIdentity'), /getAccountByIdentity/);
  });

  it('does not leak anything but the offending value', () => {
    assert.throws(() => assertChannel('signal'), /"signal"/);
  });
});

describe('normalizeExternalId', () => {
  it('still strips wid suffixes and a leading plus', () => {
    assert.equal(normalizeExternalId('2348012345678@c.us'), '2348012345678');
    assert.equal(normalizeExternalId('+2348012345678'), '2348012345678');
    assert.equal(normalizeExternalId('  216123456789017 '), '216123456789017');
    assert.equal(normalizeExternalId(undefined), '');
  });
});
