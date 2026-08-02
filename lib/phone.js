/**
 * Canonical phone numbers for claims and payment requests.
 * One implementation for every write and read path.
 *
 * Form: digits only, country code included, no plus, no leading zeros.
 * Example: +234 801-234-5678  and  02348012345678  both become 2348012345678
 *
 * Identity (LID) stays separate. Phone is only the join key for claims/requests.
 */

/**
 * @param {string} raw  phone, WhatsApp wid (user@c.us), or digits with junk
 * @returns {string} digits only, no leading zeros. Empty when the input is not
 *   a phone number at all.
 */
function normalizePhoneNumber(raw) {
  const head = String(raw || '')
    .split('@')[0]
    .trim();

  // A channel-prefixed identity key ("telegram:5566778899") is NOT a phone.
  // Stripping its non-digits would forge a plausible number out of a user id,
  // and that id could then collide with a real person's number: an admin entry
  // in ADMIN_PHONES, or a stranger's pending claim. A phone never contains a
  // letter, so reject the whole value rather than salvage digits out of it.
  if (/[a-z]/i.test(head)) return '';

  let d = head.replace(/^\+/, '').replace(/\D/g, '');
  // Local / 0-prefixed international: 0234... -> 234..., 0801... -> 801...
  d = d.replace(/^0+/, '');
  return d;
}

/**
 * E.164-style length check after normalization (ITU max 15 digits).
 * @param {string} digits
 */
function isPlausiblePhone(digits) {
  const d = normalizePhoneNumber(digits);
  return d.length >= 10 && d.length <= 15;
}

/**
 * Keys used to find claims/requests for a WhatsApp identity.
 * Prefer stored/extracted phone. Never invent a phone from a LID.
 *
 * When waPhone is set, only that phone is used (LID is not a claim address).
 * When waPhone is missing, fall back to waSenderId digits only for legacy
 * accounts where the observed sender id was already a real phone (@c.us era).
 *
 * @param {{ waSenderId?: string, waPhone?: string|null }} p
 * @returns {string[]}
 */
function claimMatchKeys(p) {
  const phone = p?.waPhone ? normalizePhoneNumber(p.waPhone) : '';
  if (phone && isPlausiblePhone(phone)) {
    return [phone];
  }
  const sid = normalizePhoneNumber(p?.waSenderId || '');
  if (sid && isPlausiblePhone(sid)) {
    return [sid];
  }
  return [];
}

/**
 * Every phone join key that should see claims/requests for this person.
 *
 * Starts with claimMatchKeys for the active chat identity, then adds every
 * plausible phone_e164 on any identity of the same account.
 *
 * Why: notifyPhone fans a request to every channel on the account, but the
 * phone may only live on the WhatsApp row. Without this, Telegram gets
 * "you have a payment request" then `pay` says there are none.
 *
 * @param {{
 *   waSenderId?: string,
 *   waPhone?: string|null,
 *   identities?: Array<{ phone_e164?: string|null, phoneE164?: string|null }>,
 * }} p
 * @returns {string[]}
 */
function claimMatchKeysForAccount(p) {
  const keys = new Set(claimMatchKeys(p));
  for (const row of p?.identities || []) {
    const raw = row?.phone_e164 ?? row?.phoneE164 ?? '';
    const phone = normalizePhoneNumber(raw);
    if (phone && isPlausiblePhone(phone)) keys.add(phone);
  }
  return [...keys];
}

/**
 * Mask for logs/UI: keep last 4 digits only.
 * @param {string} raw
 */
function maskPhone(raw) {
  const d = normalizePhoneNumber(raw);
  if (!d) return '(none)';
  if (d.length <= 4) return '****';
  return `…${d.slice(-4)}`;
}

module.exports = {
  normalizePhoneNumber,
  isPlausiblePhone,
  claimMatchKeys,
  claimMatchKeysForAccount,
  maskPhone,
};
