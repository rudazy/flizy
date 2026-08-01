/**
 * An unrecognized channel must never be silently treated as WhatsApp.
 *
 * normalizeChannel used to return 'whatsapp' for anything that was not
 * 'telegram'. External ids are numeric on every channel (WhatsApp LIDs,
 * Telegram user ids, and the GitHub/Discord/X ids coming next), so that default
 * could take one platform's id and use it as a key on another platform's rows:
 * a lookup finding the wrong account, a write binding the wrong identity, or a
 * notification delivered into a stranger's chat.
 *
 * Run: node --test test/channelKey.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CHANNELS,
  normalizeChannel,
  isKnownChannel,
  assertChannel,
  normalizeExternalId,
} = require('../lib/channelKey');

describe('normalizeChannel', () => {
  it('canonicalizes the channels we support', () => {
    assert.equal(normalizeChannel('whatsapp'), CHANNELS.WHATSAPP);
    assert.equal(normalizeChannel('telegram'), CHANNELS.TELEGRAM);
  });

  it('tolerates case and surrounding whitespace', () => {
    assert.equal(normalizeChannel('  WhatsApp '), CHANNELS.WHATSAPP);
    assert.equal(normalizeChannel('TELEGRAM'), CHANNELS.TELEGRAM);
  });

  it('returns null for a channel it does not know', () => {
    for (const raw of ['github', 'discord', 'x', 'signal', 'whatsapp2', 'what']) {
      assert.equal(normalizeChannel(raw), null, `${raw} should not resolve`);
    }
  });

  it('returns null for empty and missing input instead of defaulting', () => {
    assert.equal(normalizeChannel(''), null);
    assert.equal(normalizeChannel('   '), null);
    assert.equal(normalizeChannel(undefined), null);
    assert.equal(normalizeChannel(null), null);
  });

  it('regression: a platform channel never resolves to WhatsApp', () => {
    // The exact shape of the old bug. A GitHub id is numeric, as is a WhatsApp
    // LID, so resolving to WhatsApp here put the two in the same key space.
    assert.notEqual(normalizeChannel('github'), CHANNELS.WHATSAPP);
    assert.notEqual(normalizeChannel('discord'), CHANNELS.WHATSAPP);
    assert.notEqual(normalizeChannel('x'), CHANNELS.WHATSAPP);
  });
});

describe('isKnownChannel', () => {
  it('is true only for supported channels', () => {
    assert.equal(isKnownChannel('whatsapp'), true);
    assert.equal(isKnownChannel('telegram'), true);
    assert.equal(isKnownChannel('github'), false);
    assert.equal(isKnownChannel(''), false);
  });
});

describe('assertChannel', () => {
  it('returns the canonical key for a supported channel', () => {
    assert.equal(assertChannel('WhatsApp'), CHANNELS.WHATSAPP);
    assert.equal(assertChannel('telegram'), CHANNELS.TELEGRAM);
  });

  it('throws on an unknown channel rather than picking one', () => {
    assert.throws(() => assertChannel('github'), /unknown channel/i);
    assert.throws(() => assertChannel(''), /unknown channel/i);
    assert.throws(() => assertChannel(undefined), /unknown channel/i);
  });

  it('names the caller so the failure points at the right code', () => {
    assert.throws(() => assertChannel('github', 'getAccountByIdentity'), /getAccountByIdentity/);
  });

  it('does not leak anything but the offending value', () => {
    assert.throws(() => assertChannel('github'), /"github"/);
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
