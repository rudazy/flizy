/**
 * Who a claim is held for.
 *
 * A claim is addressed exactly one of three ways:
 *
 *   phone     the recipient proves a phone number (to_wa_hint)
 *   platform  the recipient proves a platform identity (to_channel + to_external_id)
 *   email     the recipient owns that email on Flizy (to_email)
 *
 * Both end in the same place: the money only moves once the recipient has
 * proven that identity on a Flizy account. Neither a typed phone, handle, nor
 * email is ever proof on its own.
 *
 * Platform claims bind to the platform's IMMUTABLE user id, never the handle.
 * Handles are renamed and reassigned, so matching on one would eventually pay
 * whoever picked up the name. The handle is carried alongside for display only.
 *
 * Email claims bind to the normalized address. Registration email
 * (accounts.email) and verified secondary emails (account_emails.verified_at)
 * are the match keys. Email is its own mode because normalizeExternalId strips
 * "@" and cannot store an address.
 *
 * Pure module: no database, no network. The matching rules are the part that
 * decides who gets paid, so they are kept testable on their own.
 */

const { CHANNELS, assertChannel, normalizeExternalId } = require('./channelKey');
const { normalizePhoneNumber, isPlausiblePhone } = require('./phone');
const { normalizeEmail, isValidEmail, maskEmail } = require('./email');
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
 * @property {'phone'|'platform'|'email'} kind
 * @property {string} [phone] digits, phone mode only
 * @property {string} [channel] platform mode only
 * @property {string} [externalId] platform mode only, the immutable id
 * @property {string|null} [displayHandle] platform mode only, display text
 * @property {string} [email] email mode only, normalized lowercased
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
 * @param {string} raw
 * @returns {ClaimRecipient}
 */
function emailRecipient(raw) {
  const email = normalizeEmail(raw);
  if (!isValidEmail(email)) {
    throw new Error('Invalid email address.');
  }
  return { kind: 'email', email };
}

/** Prefix for Telegram claims held by @username until the user links Flizy. */
const TG_PENDING_USER_PREFIX = 'tguser:';

/**
 * @param {string} externalId
 * @returns {boolean}
 */
function isTelegramPendingUsernameId(externalId) {
  return String(externalId || '').toLowerCase().startsWith(TG_PENDING_USER_PREFIX);
}

/**
 * @param {string} externalId
 * @returns {string} bare handle lowercased, or empty
 */
function telegramPendingUsernameFromId(externalId) {
  const s = String(externalId || '');
  if (!isTelegramPendingUsernameId(s)) return '';
  return s.slice(TG_PENDING_USER_PREFIX.length).trim().toLowerCase().replace(/^@+/, '');
}

/**
 * Claim held for a Telegram @username that Bot API could not resolve to an id
 * (private users). Pays out when that handle is linked on Flizy and claims.
 * Handle is matched case-insensitively at claim time; username reassignment is
 * a residual risk disclosed on the confirm screen.
 *
 * @param {string} handleRaw
 * @returns {ClaimRecipient}
 */
function telegramPendingUsernameRecipient(handleRaw) {
  const handle = String(handleRaw || '')
    .trim()
    .replace(/^@+/, '');
  if (!handle || handle.length < 5 || handle.length > 32) {
    throw new Error('Invalid Telegram username.');
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(handle)) {
    throw new Error('Invalid Telegram username.');
  }
  const key = handle.toLowerCase();
  return {
    kind: 'platform',
    channel: CHANNELS.TELEGRAM,
    externalId: `${TG_PENDING_USER_PREFIX}${key}`,
    displayHandle: handle,
    pendingUsername: true,
  };
}

/**
 * @param {string} channel
 * @param {string} externalId the platform's immutable user id, or tguser:handle
 * @param {string} [displayHandle] shown to humans; also used for tguser match
 * @returns {ClaimRecipient}
 */
function platformRecipient(channel, externalId, displayHandle) {
  const ch = assertChannel(channel, 'platformRecipient');
  const raw = String(externalId ?? '').trim();

  // Telegram pending-by-username (Bot API cannot resolve private users).
  if (ch === CHANNELS.TELEGRAM && isTelegramPendingUsernameId(raw)) {
    const key = telegramPendingUsernameFromId(raw);
    if (!key) throw new Error('Invalid Telegram pending username key');
    const handle = displayHandle
      ? String(displayHandle).trim().replace(/^@+/, '')
      : key;
    return {
      kind: 'platform',
      channel: ch,
      externalId: `${TG_PENDING_USER_PREFIX}${key}`,
      displayHandle: handle || key,
      pendingUsername: true,
    };
  }

  const id = normalizeExternalId(externalId);

  // A handle is not an id. Storing one here would make the claim payable to
  // whoever holds that name later, which is the whole failure this design
  // exists to avoid, so it is refused rather than accepted and hoped about.
  //
  // Every channel in CHANNELS keys its users by a numeric id: WhatsApp LIDs,
  // Telegram user ids, GitHub ids, Discord snowflakes, X ids. Requiring digits
  // is therefore the tightest available guard — except tguser: (above).
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
    const rawId = String(row.to_external_id || '').trim();
    // Do not run normalizeExternalId on tguser: keys (would not strip, but keep exact).
    if (isTelegramPendingUsernameId(rawId)) {
      return platformRecipient(row.to_channel, rawId, row.to_display_handle || null);
    }
    return {
      kind: 'platform',
      channel: row.to_channel,
      externalId: normalizeExternalId(row.to_external_id),
      displayHandle: row.to_display_handle || null,
    };
  }
  if (row.to_email) {
    const email = normalizeEmail(row.to_email);
    if (!email) return null;
    return { kind: 'email', email };
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
      to_email: null,
    };
  }
  if (recipient?.kind === 'email') {
    return {
      to_wa_hint: null,
      to_channel: null,
      to_external_id: null,
      to_display_handle: null,
      to_email: recipient.email,
    };
  }
  if (recipient?.kind === 'phone') {
    return {
      to_wa_hint: recipient.phone,
      to_channel: null,
      to_external_id: null,
      to_display_handle: null,
      to_email: null,
    };
  }
  throw new Error('Claim needs a recipient');
}

/**
 * Human label for a recipient, safe to put in a plan or a menu.
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
  if (r.kind === 'email') return displaySafeLabel(r.email);

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
 * @param {object} row claims row
 */
function publicRecipientLabel(row) {
  const r = recipientFromRow(row);
  if (!r) return null;
  if (r.kind === 'phone') return `...${r.phone.slice(-4)}`;
  if (r.kind === 'email') return maskEmail(r.email);
  const where = channelLabel(r.channel);
  return r.displayHandle ? `@${displaySafeLabel(r.displayHandle)} (${where})` : `a ${where} user`;
}

/**
 * Every key a recipient can be reached by, from their proven identities.
 *
 * @param {{
 *   phones?: Array<string|null>,
 *   identities?: Array<{
 *     channel: string,
 *     external_id?: string,
 *     externalId?: string,
 *     display_handle?: string|null,
 *     displayHandle?: string|null,
 *   }>,
 *   emails?: Array<string|null>,
 * }} p
 * @returns {{
 *   phones: string[],
 *   identities: Array<{ channel: string, externalId: string, displayHandle: string|null }>,
 *   emails: string[],
 * }}
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
    const displayHandle = String(row?.display_handle ?? row?.displayHandle ?? '')
      .trim()
      .replace(/^@+/, '') || null;
    if (!identities.some((i) => i.channel === ch && i.externalId === id)) {
      identities.push({ channel: ch, externalId: id, displayHandle });
    }
    // Synthetic key so pending-by-@username claims match once the handle is stored.
    if (ch === CHANNELS.TELEGRAM && displayHandle) {
      const pendingId = `${TG_PENDING_USER_PREFIX}${displayHandle.toLowerCase()}`;
      if (!identities.some((i) => i.channel === ch && i.externalId === pendingId)) {
        identities.push({
          channel: ch,
          externalId: pendingId,
          displayHandle,
        });
      }
    }
  }

  const emails = [];
  for (const raw of p?.emails || []) {
    const email = normalizeEmail(raw || '');
    if (email && isValidEmail(email) && !emails.includes(email)) {
      emails.push(email);
    }
  }

  return { phones, identities, emails };
}

/**
 * Is this claim addressed to one of these proven identities?
 *
 * @param {object} row claims row
 * @param {{
 *   phones: string[],
 *   identities: Array<{ channel: string, externalId: string, displayHandle?: string|null }>,
 *   emails?: string[],
 * }} keys
 * @returns {boolean}
 */
function claimMatchesRecipient(row, keys) {
  const r = recipientFromRow(row);
  if (!r || !keys) return false;

  if (r.kind === 'platform') {
    // Exact id match (numeric platform id or tguser:handle synthetic key).
    if (
      (keys.identities || []).some(
        (i) => i.channel === r.channel && i.externalId === r.externalId
      )
    ) {
      return true;
    }
    // Pending Telegram @username: also match live display_handle on a linked TG row.
    if (r.channel === CHANNELS.TELEGRAM && isTelegramPendingUsernameId(r.externalId)) {
      const want = telegramPendingUsernameFromId(r.externalId);
      if (!want) return false;
      return (keys.identities || []).some((i) => {
        if (i.channel !== CHANNELS.TELEGRAM) return false;
        const h = String(i.displayHandle || '')
          .trim()
          .replace(/^@+/, '')
          .toLowerCase();
        return h === want;
      });
    }
    return false;
  }
  if (r.kind === 'email') {
    return (keys.emails || []).includes(r.email);
  }
  return (keys.phones || []).includes(r.phone);
}

module.exports = {
  CHANNEL_LABELS,
  channelLabel,
  TG_PENDING_USER_PREFIX,
  isTelegramPendingUsernameId,
  telegramPendingUsernameFromId,
  telegramPendingUsernameRecipient,
  phoneRecipient,
  emailRecipient,
  platformRecipient,
  recipientFromRow,
  recipientColumns,
  claimRecipientLabel,
  publicRecipientLabel,
  recipientKeys,
  claimMatchesRecipient,
};
