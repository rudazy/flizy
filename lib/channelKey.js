/**
 * How a chat identity is keyed, on its own so anything can normalize a
 * (channel, external id) pair without pulling in account lookups.
 *
 * lib/identity.js re-exports all of this, so existing call sites are unchanged.
 * It lives apart because lib/session.js and lib/linkAttempts.js need only the
 * normalizers, and lib/identity.js needs lib/linkAttempts.js: leaving them in
 * identity made that a require cycle.
 *
 * HARD RULE: an unrecognized channel is never silently treated as WhatsApp.
 * This used to return 'whatsapp' for anything that was not 'telegram', so a
 * typo, or a channel named in code before it was added to this list, produced
 * a WhatsApp read or write instead of an error. External ids are numeric on
 * every channel supported or planned (WhatsApp LIDs, Telegram user ids, later
 * GitHub and Discord and X ids), so that coercion could land one platform's id
 * on another platform's row. Unknown now means null, and every path that uses
 * a channel as part of a row key refuses it outright.
 */

const CHANNELS = Object.freeze({
  WHATSAPP: 'whatsapp',
  TELEGRAM: 'telegram',
  // Platform identities. External id is the platform's immutable numeric user
  // id, never the handle: handles are renamed and reassigned, the id is not.
  // Recognized here so identities can exist; nothing creates one yet.
  X: 'x',
  GITHUB: 'github',
  DISCORD: 'discord',
});

/**
 * Every channel this code may read or write.
 *
 * Adding one here is only half the change: channel_identities, sessions and
 * notifications each carry their own database CHECK constraint on the same
 * list, so a new channel needs its migration landed with it or the write fails.
 * The current list is widened by 20260801120000_platform_channels.sql.
 */
const KNOWN_CHANNELS = Object.freeze(new Set(Object.values(CHANNELS)));

/**
 * Canonical channel key, or null when it is not one we know.
 *
 * Never throws. Callers on the inbound message path use the result as a
 * comparison (=== CHANNELS.TELEGRAM), where null simply means "not that
 * channel". Anything using the result as a row key must use assertChannel.
 *
 * @param {string} raw
 * @returns {string|null} channel key, or null when unrecognized
 */
function normalizeChannel(raw) {
  const c = String(raw || '').trim().toLowerCase();
  return KNOWN_CHANNELS.has(c) ? c : null;
}

/** @param {string} raw */
function isKnownChannel(raw) {
  return normalizeChannel(raw) !== null;
}

/**
 * Canonical channel key, or throw. Use this everywhere a channel becomes part
 * of a row key, so an unknown channel fails loudly instead of reading or
 * writing on somebody else's channel.
 *
 * @param {string} raw
 * @param {string} [context] caller name, for the message
 * @returns {string} channel key
 */
function assertChannel(raw, context = 'channel') {
  const ch = normalizeChannel(raw);
  if (!ch) {
    throw new Error(`${context}: unknown channel ${JSON.stringify(String(raw || ''))}`);
  }
  return ch;
}

/**
 * Canonical external id. Strips wid suffixes and a leading plus so the same
 * WhatsApp sender always resolves to one row.
 * @param {string} raw
 */
function normalizeExternalId(raw) {
  return String(raw || '')
    .split('@')[0]
    .trim()
    .replace(/^\+/, '');
}

module.exports = {
  CHANNELS,
  KNOWN_CHANNELS,
  normalizeChannel,
  isKnownChannel,
  assertChannel,
  normalizeExternalId,
};
