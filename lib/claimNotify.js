/**
 * Telling a claim's recipient who is not on Flizy yet: one adapter per
 * channel, each saying whether it can reach such a person and sending if so.
 * The share link always works: the sender forwards it, so the message comes
 * from someone the recipient knows.
 *
 * What each channel allows today:
 *
 *   email       can reach anyone, once an email sender is registered
 *               (registerNoticeSender). On unless CLAIM_NOTIFY_EMAIL=false
 *   telegram    cannot: a bot cannot message someone who never started it.
 *               The share link carries a link that opens the bot instead
 *   whatsapp    cannot yet: Flizy runs on whatsapp-web.js, and messaging a
 *               number that never wrote first risks a ban of Flizy's number.
 *               Waits for the official Business API
 *   discord     cannot: unsolicited bot messages are not allowed
 *   github      cannot: no direct messages
 *   x           cannot: share link only
 *
 * A channel reaches a non-user only when it has a sender AND its setting is
 * on (true, or unset for a channel in ON_BY_DEFAULT), so turning one on later
 * is a sender plus a setting, never a change to the callers. Recipients already on Flizy are told on their linked chats as
 * before (lib/handlers/claims.js); this is only for everyone else.
 */

const { recordClaimEvent } = require('./claimEvents');

/** channel -> the setting that turns it on, or null where no sender could ever be allowed. */
const SETTINGS = Object.freeze({
  email: 'CLAIM_NOTIFY_EMAIL',
  whatsapp: 'CLAIM_NOTIFY_WHATSAPP',
  telegram: null,
  discord: null,
  github: null,
  x: null,
});

/** Channels that are on while their setting is unset. Setting it to false turns them off. */
const ON_BY_DEFAULT = Object.freeze(new Set(['email']));

const senders = new Map();

/** Whether a channel's setting is on: true, or unset where the channel is on by default. */
function channelOn(channel, env = process.env) {
  const setting = SETTINGS[channel];
  if (!setting) return false;
  const value = String(env[setting] ?? '').trim().toLowerCase();
  if (!value) return ON_BY_DEFAULT.has(channel);
  return value === 'true';
}

/**
 * Give a channel its sender: async ({ claim, env }) => boolean, true when the
 * message was accepted. Only channels with a setting take one.
 */
function registerNoticeSender(channel, send) {
  if (!SETTINGS[channel]) throw new Error(`${channel} cannot carry claim notices`);
  if (typeof send !== 'function') throw new Error('a notice sender is a function');
  senders.set(channel, send);
}

/** The channel a recipient would be told on: email, the phone's WhatsApp, or the platform. */
function recipientChannel(recipient) {
  if (!recipient) return null;
  if (recipient.kind === 'email') return 'email';
  if (recipient.kind === 'phone') return 'whatsapp';
  if (recipient.kind === 'platform') return Object.prototype.hasOwnProperty.call(SETTINGS, recipient.channel) ? recipient.channel : null;
  return null;
}

/** Can this channel reach someone not on Flizy right now? */
function canReach(channel, env = process.env) {
  return senders.has(channel) && channelOn(channel, env);
}

/**
 * Tell a recipient not on Flizy on their own channel, when it can. Never
 * throws: the claim is held either way and the share link still works.
 * Records notified only when the message was accepted.
 * @returns {Promise<string|null>} the channel that carried it, or null
 */
async function noticeNonUser({ supabase, claim, recipient, env = process.env, log = console }) {
  const channel = recipientChannel(recipient);
  if (!channel || !canReach(channel, env)) return null;
  try {
    const accepted = await senders.get(channel)({ claim, env });
    if (!accepted) return null;
    await recordClaimEvent(supabase, claim.id, 'notified', { channel });
    return channel;
  } catch (err) {
    log.warn(`[claim-notice] ${channel} notice failed: ${String((err && err.message) || err).slice(0, 120)}`);
    return null;
  }
}

module.exports = { registerNoticeSender, recipientChannel, channelOn, canReach, noticeNonUser };
