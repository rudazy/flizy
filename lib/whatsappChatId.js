/**
 * Build WhatsApp Web chat ids for outbound notify (no inbound message).
 *
 * channel_identities.external_id is LID-first bare digits. A LID is often 15
 * digits, which passes a phone-length check, so routing only to @c.us fails:
 * the message never lands and the outbox retries until status=failed.
 *
 * Order: @lid first (current WA), then @c.us (legacy phone-as-id accounts).
 */

const { isPlausiblePhone } = require('./phone');

/**
 * @param {string} externalId bare id or id@server
 * @returns {string[]} candidate chat ids to try in order
 */
function whatsappOutboundChatIds(externalId) {
  const id = String(externalId || '')
    .split('@')[0]
    .trim();
  if (!id) return [];
  if (isPlausiblePhone(id)) {
    return [`${id}@lid`, `${id}@c.us`];
  }
  return [`${id}@lid`];
}

module.exports = { whatsappOutboundChatIds };
