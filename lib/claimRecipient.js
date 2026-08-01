/**
 * Who a claim is held for.
 *
 * A claim is addressed exactly one of two ways:
 *
 *   phone     the recipient proves a phone number (to_wa_hint)
 *   platform  the recipient proves a platform identity (to_channel + to_external_id)
 *
 * Both end in the same place: the money only moves once the recipient has
 * proven that identity on a Flizy account. Neither a typed phone nor a typed
 * handle is ever proof on its own.
 *
 * Platform claims bind to the platform's IMMUTABLE user id, never the handle.
 * Handles are renamed and reassigned, so matching on one would eventually pay
 * whoever picked up the name. The handle is carried alongside for display only.
 *
 * Pure module: no database, no network. The matching rules are the part that
 * decides who gets paid, so they are kept testable on their own.
 */

const { CHANNELS, assertChannel, normalizeExternalId } = require('./channelKey');
const { normalizePhoneNumber, isPlausiblePhone } = require('./phone');
const { displaySafeLabel } = require('./sanitize');

/** How each channel is named on screen. */
const CHANNEL_LABELS = Object.freeze({
  [CHANNELS.WHATSAPP]: 'WhatsApp',
  [CHANNELS.TELEGRAM]: 'Telegram',
  [CHANNELS.X]: 'X',
  [CHANNELS.GITHUB]: 'GitHub',
  [CHANNELS.DISCORD]: 'Discord',
});

/** @param {string} channel */
function channelLabel(channel) {
  return CHANNEL_LABELS[channel] || String(channel || '');
}

/**
 * @typedef {object} ClaimRecipient
 * @property {'phone'|'platform'} kind
 * @property {string} [phone] digits, phone mode only
 * @property {string} [channel] platform mode only
 * @property {string} [externalId] platform mode only, the immutable id
 * @property {string|null} [displayHandle] platform mode only, display text
 */

/**
 * @param {string} raw
 * @returns {ClaimRecipient}
 */
function phoneRecipient(raw) {
  const phone = normalizePhoneNumber(raw);
  if (!isPlausiblePhone(phone)) {
    throw new Error('Invalid phone. Use country code digits, e.g. 2348012345678');
  }
  return { kind: 'phone', phone };
}

/**
 * @param {string} channel
 * @param {string} externalId the platform's immutable user id
 * @param {string} [displayHandle] shown to humans, never matched on
 * @returns {ClaimRecipient}
 */
function platformRecipient(channel, externalId, displayHandle) {
  const ch = assertChannel(channel, 'platformRecipient');
  const raw = String(externalId ?? '').trim();
  const id = normalizeExternalId(externalId);

  // A handle is not an id. Storing one here would make the claim payable to
  // whoever holds that name later, which is the whole failure this design
  // exists to avoid, so it is refused rather than accepted and hoped about.
  //
  // Every channel in CHANNELS keys its users by a numeric id: WhatsApp LIDs,
  // Telegram user ids, GitHub ids, Discord snowflakes, X ids. Requiring digits
  // is therefore the tightest available guard. Revisit only if a channel with
  // non-numeric user ids is ever added.
  //
  // Checked before the empty test, because normalizeExternalId splits on "@"
  // and would turn "@jack" into an empty string, reporting a missing id when
  // the real problem is that a handle was passed.
  if (raw && !/^\d+$/.test(id)) {
    throw new Error('Platform claim external id must be the numeric user id, not the handle');
  }
  if (!id) {
    throw new Error('Platform claim needs the recipient user id');
  }
  const handle = displayHandle ? String(displayHandle).trim().replace(/^@+/, '') : '';
  return {
    kind: 'platform',
    channel: ch,
    externalId: id,
    displayHandle: handle || null,
  };
}

/**
 * Read the recipient back off a claims row.
 * @param {object} row
 * @returns {ClaimRecipient|null}
 */
function recipientFromRow(row) {
  if (!row) return null;
  if (row.to_channel) {
    return {
      kind: 'platform',
      channel: row.to_channel,
      externalId: normalizeExternalId(row.to_external_id),
      displayHandle: row.to_display_handle || null,
    };
  }
  const phone = normalizePhoneNumber(row.to_wa_hint);
  if (!phone) return null;
  return { kind: 'phone', phone };
}

/**
 * The claims columns for a recipient. Exactly one mode is ever populated, which
 * is also enforced by claims_recipient_mode_check in the database.
 *
 * @param {ClaimRecipient} recipient
 */
function recipientColumns(recipient) {
  if (recipient?.kind === 'platform') {
    return {
      to_wa_hint: null,
      to_channel: recipient.channel,
      to_external_id: recipient.externalId,
      to_display_handle: recipient.displayHandle || null,
    };
  }
  if (recipient?.kind === 'phone') {
    return {
      to_wa_hint: recipient.phone,
      to_channel: null,
      to_external_id: null,
      to_display_handle: null,
    };
  }
  throw new Error('Claim needs a recipient');
}

/**
 * Human label for a recipient, safe to put in a plan or a menu.
 *
 * The handle is text the sender typed or a platform returned, so it goes
 * through displaySafeLabel: a newline in it would otherwise let someone forge
 * an extra "Amount:" or "To:" line on a confirm screen.
 *
 * @param {ClaimRecipient|object} recipientOrRow
 * @returns {string}
 */
function claimRecipientLabel(recipientOrRow) {
  const r =
    recipientOrRow && recipientOrRow.kind
      ? recipientOrRow
      : recipientFromRow(recipientOrRow);
  if (!r) return 'recipient';

  if (r.kind === 'phone') return `+${r.phone}`;

  const where = channelLabel(r.channel);
  if (r.displayHandle) {
    return `@${displaySafeLabel(r.displayHandle)} (${where})`;
  }
  // Never invent a handle. An id is not pretty, but it is true.
  return `${where} user ${displaySafeLabel(r.externalId)}`;
}

/**
 * Label for a page anyone holding the claim link can read.
 *
 * Phones stay masked to the last 4, as they always have. A platform handle is
 * a public identifier the sender typed on purpose and the recipient needs it to
 * recognize the claim as theirs, so it is shown; the numeric id is not, because
 * nothing on a public page needs it.
 *
 * @param {object} row claims row
 */
function publicRecipientLabel(row) {
  const r = recipientFromRow(row);
  if (!r) return null;
  if (r.kind === 'phone') return `...${r.phone.slice(-4)}`;
  const where = channelLabel(r.channel);
  return r.displayHandle ? `@${displaySafeLabel(r.displayHandle)} (${where})` : `a ${where} user`;
}

/**
 * Every key a recipient can be reached by, from their proven identities.
 *
 * @param {{ phones?: Array<string|null>, identities?: Array<{ channel: string, external_id?: string, externalId?: string }> }} p
 * @returns {{ phones: string[], identities: Array<{ channel: string, externalId: string }> }}
 */
function recipientKeys(p) {
  const phones = [];
  for (const raw of p?.phones || []) {
    const phone = normalizePhoneNumber(raw || '');
    if (phone && isPlausiblePhone(phone) && !phones.includes(phone)) {
      phones.push(phone);
    }
  }

  const identities = [];
  for (const row of p?.identities || []) {
    // Unknown channels are dropped rather than defaulted, same rule as the rest
    // of the system: a channel we cannot name is not a channel we can pay.
    let ch;
    try {
      ch = assertChannel(row?.channel, 'recipientKeys');
    } catch {
      continue;
    }
    const id = normalizeExternalId(row?.external_id ?? row?.externalId);
    if (!id) continue;
    if (!identities.some((i) => i.channel === ch && i.externalId === id)) {
      identities.push({ channel: ch, externalId: id });
    }
  }

  return { phones, identities };
}

/**
 * Is this claim addressed to one of these proven identities?
 *
 * This is the check that decides who is allowed to be paid, so it is exact:
 * a platform claim matches only an identity on the same channel with the same
 * id, and a phone claim matches only an equal phone. There is no fallback
 * between the two modes.
 *
 * @param {object} row claims row
 * @param {{ phones: string[], identities: Array<{ channel: string, externalId: string }> }} keys
 * @returns {boolean}
 */
function claimMatchesRecipient(row, keys) {
  const r = recipientFromRow(row);
  if (!r || !keys) return false;

  if (r.kind === 'platform') {
    return (keys.identities || []).some(
      (i) => i.channel === r.channel && i.externalId === r.externalId
    );
  }
  return (keys.phones || []).includes(r.phone);
}

module.exports = {
  CHANNEL_LABELS,
  channelLabel,
  phoneRecipient,
  platformRecipient,
  recipientFromRow,
  recipientColumns,
  claimRecipientLabel,
  publicRecipientLabel,
  recipientKeys,
  claimMatchesRecipient,
};
