/**
 * Whether a message the bot's own WhatsApp account sent may be read as input.
 *
 * whatsapp-web.js reports every message the bot account sends, in every chat,
 * as fromMe. Reading those as commands ran them on the account of whoever the
 * chat was with, so anyone holding the bot's phone or its session files could
 * act as any user. Only the bot's own chat (Message yourself) counts: the
 * message has to be addressed to the bot itself.
 *
 * Pure: it takes the ids and asks WhatsApp nothing, so the rule is testable and
 * cannot be widened by a chat's display name.
 */

/**
 * @param {{ from?: string|null, to?: string|null }} message
 * @param {string} botUser the bot's own number, already normalized
 * @param {(raw: string) => string} normalize the phone normalizer the bot uses
 * @returns {boolean}
 */
function isBotSelfChat(message, botUser, normalize) {
  const fromN = normalize(String((message && message.from) || ''));
  const toN = normalize(String((message && message.to) || ''));
  if (!fromN || !toN) return false;
  // Message yourself: both ends are the bot, in whichever id form WhatsApp used.
  if (fromN === toN) return true;
  return Boolean(botUser) && toN === botUser;
}

module.exports = { isBotSelfChat };
