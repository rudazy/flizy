/**
 * How a chat identity is keyed, on its own so anything can normalize a
 * (channel, external id) pair without pulling in account lookups.
 *
 * lib/identity.js re-exports all of this, so existing call sites are unchanged.
 * It lives apart because lib/session.js and lib/linkAttempts.js need only the
 * normalizers, and lib/identity.js needs lib/linkAttempts.js: leaving them in
 * identity made that a require cycle.
 */

const CHANNELS = Object.freeze({
  WHATSAPP: 'whatsapp',
  TELEGRAM: 'telegram',
});

/**
 * @param {string} raw
 * @returns {string} channel key
 */
function normalizeChannel(raw) {
  const c = String(raw || '').trim().toLowerCase();
  if (c === CHANNELS.TELEGRAM) return CHANNELS.TELEGRAM;
  return CHANNELS.WHATSAPP;
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
  normalizeChannel,
  normalizeExternalId,
};
