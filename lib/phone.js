/**
 * Canonical phone numbers for claims and payment requests.
 * One implementation for every write and read path.
 *
 * Stored form: E.164 digits, country code included, no plus, no spaces.
 * +234 708 043 7343, +234-708-043-7343 and +2347080437343 are one identity.
 *
 * A leading 0 on a short number is a national trunk prefix. Flizy does not
 * guess the country. A code is added only when that person saved one.
 * 00 is the international dial prefix and is removed.
 * A single 0 in front of an already-complete international number
 * (02348012345678, 14 digits) is the same number with the trunk typed twice.
 *
 * Identity (LID) stays separate. Phone is only the join key for claims/requests.
 */

/**
 * The example shown in chat and on the site. One string, so the two cannot
 * teach different formats.
 */
const PHONE_EXAMPLE_LOCAL = '+234 708 043 7343';
const PHONE_EXAMPLE_E164 = '2347080437343';
const PHONE_EXAMPLE_COMMAND = `send 0.01 ETH to ${PHONE_EXAMPLE_LOCAL}`;

const {
  normalizeCallingCode,
  lookupCallingCode,
  lookupCountry,
  countryByIso,
  countryFlag,
  internationalCallingPrefix,
  describeCallingCode,
  callingCodeOptions,
} = require('./phoneCountries');

/**
 * Countries offered when a chat command has no country code and no saved one.
 * A reply can still name any other country or calling code. This list is the
 * prompt, not a closed set. 1, 2 and 3 mean these three rows, never a code.
 */
const PHONE_COUNTRY_CHOICES = Object.freeze([
  { keyword: 'nigeria', aliases: ['ng', '+234', '234'], callingCode: '234', label: `${countryFlag('NG')} Nigeria +234` },
  { keyword: 'ghana', aliases: ['gh', '+233', '233'], callingCode: '233', label: `${countryFlag('GH')} Ghana +233` },
  {
    keyword: 'uk',
    aliases: ['united kingdom', 'britain', 'gb', '+44', '44'],
    callingCode: '44',
    label: `${countryFlag('GB')} United Kingdom +44`,
  },
]);

/**
 * @param {string} raw
 * @returns {{ head: string, hasPlus: boolean, digits: string } | null}
 */
function splitPhone(raw) {
  const head = String(raw || '')
    .split('@')[0]
    .trim();
  if (!head) return null;
  // A channel-prefixed identity key ("telegram:5566778899") is NOT a phone.
  // Stripping its non-digits would forge a plausible number out of a user id,
  // and that id could then collide with a real person's number: an admin entry
  // in ADMIN_PHONES, or a stranger's pending claim. A phone never contains a
  // letter, so reject the whole value rather than salvage digits out of it.
  if (/[a-z]/i.test(head)) return null;
  return { head, hasPlus: head.startsWith('+'), digits: head.replace(/\D/g, '') };
}

/**
 * @param {string} raw  phone, WhatsApp wid (user@c.us), or digits with spaces
 * @returns {string} E.164 digits, or the original digits when they are not a
 *   phone at all (short ids). Empty when the value is a national number or
 *   not a phone. National numbers are empty on purpose: guessing a country
 *   would store the wrong identity.
 */
function normalizePhoneNumber(raw) {
  const parsed = splitPhone(raw);
  if (!parsed || !parsed.digits) return '';
  let d = parsed.digits;

  // 00 is the international exit code. 00234... is +234...
  if (d.startsWith('00')) return d.replace(/^0+/, '');

  // One trunk 0 in front of a full international number: 02348012345678.
  // Shorter than that, the 0 is a national trunk prefix. Do not drop it and
  // pretend the rest is already a country code.
  if (d.startsWith('0')) {
    if (d.length >= 13) {
      const rest = d.replace(/^0+/, '');
      if (rest.length >= PHONE_MIN_DIGITS && rest.length <= PHONE_MAX_DIGITS) return rest;
    }
    return '';
  }
  return d;
}

/**
 * E.164-style length check after normalization (ITU max 15 digits).
 * @param {string} digits
 */
/**
 * Shortest digit run Flizy will read as a phone number.
 *
 * The pay code length is chosen to sit BELOW this, so a bare pay code can never
 * be mistaken for a phone in any country. test/payCode.test.js asserts that
 * relationship: lower this floor and that test fails, which is the point.
 */
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

function isPlausiblePhone(digits) {
  const d = normalizePhoneNumber(digits);
  return d.length >= PHONE_MIN_DIGITS && d.length <= PHONE_MAX_DIGITS;
}

/**
 * Read a phone a person typed.
 *
 * e164: country code is present. Spaces, dashes, dots and brackets are ignored.
 * needs_country: a national number. A trunk 0 is removed. A number such as
 *   10 1234 5678 has no trunk and no known country code, so it is national too.
 *   A 10-digit number is national even when it starts with another country's
 *   code: 2025550100 is a local number, not Egypt. An unmarked 11-digit number
 *   is national too: 13812345678 is a Chinese mobile, and it is also a plausible
 *   +1 number, so the saved country has to decide. national is display and
 *   compose only. It is not an identity and must not be stored.
 * invalid: not a phone. Nine digits is a Flizy number, so it is invalid here
 *   and the pay-code parser keeps it.
 *
 * @param {string} raw
 * @returns {{ status: 'e164', e164: string }
 *   | { status: 'needs_country', national: string }
 *   | { status: 'invalid' }}
 */
function interpretPhoneInput(raw) {
  const parsed = splitPhone(raw);
  if (!parsed || !parsed.digits) return { status: 'invalid' };
  const { head, hasPlus, digits } = parsed;
  if (!/^\+?[0-9][0-9\s().-]*$/.test(head)) return { status: 'invalid' };
  // Nine digits is a Flizy number. A leading 0 must not turn it into a
  // country question, and it must not become a phone.
  if (!hasPlus && digits.length === 9) return { status: 'invalid' };

  const canonical = normalizePhoneNumber(head);
  // Plus or 00 means the person already included the country. Without that
  // mark, 10 or 11 digits is a local number. Twelve or more can already be
  // international: 821012345678 and 2347080437343 stay as written.
  // 2025550100 does not become Egypt. 13812345678 does not become +1.
  // A longer run that starts with 1 is not +1 either. +1 is exactly 11
  // digits, and no other calling code starts with 1.
  const implicitInternational =
    !hasPlus &&
    !digits.startsWith('0') &&
    digits.length >= 12 &&
    Boolean(internationalCallingPrefix(digits, 10));
  const explicit = hasPlus || digits.startsWith('00') || implicitInternational;
  if (
    explicit &&
    canonical &&
    canonical.length >= PHONE_MIN_DIGITS &&
    canonical.length <= PHONE_MAX_DIGITS &&
    !canonical.startsWith('0')
  ) {
    return { status: 'e164', e164: canonical };
  }

  // Trunk 0, and not long enough to already contain a country code.
  if (digits.startsWith('0') && !digits.startsWith('00') && digits.length >= 10 && digits.length < 13) {
    const national = digits.replace(/^0+/, '');
    if (national.length >= 6 && national.length <= 12) {
      return { status: 'needs_country', national };
    }
  }

  // Local digits with no trunk 0 and no known country code: 10 1234 5678.
  if (!hasPlus && !digits.startsWith('0') && digits.length >= PHONE_MIN_DIGITS && digits.length <= 12) {
    return { status: 'needs_country', national: digits };
  }

  if (
    canonical &&
    canonical.length >= PHONE_MIN_DIGITS &&
    canonical.length <= PHONE_MAX_DIGITS &&
    !canonical.startsWith('0')
  ) {
    // 13 to 15 digits with no recognized code still count, so a country
    // that is not in the list can be typed in full. A number that starts
    // with 1 is the exception: it is +1 only when it is exactly 11 NANP
    // digits. 1381234567890 must not be sent as that digit string.
    if (canonical.startsWith('1') && !/^1[2-9]\d{2}[2-9]\d{6}$/.test(canonical)) {
      return { status: 'needs_country', national: canonical };
    }
    return { status: 'e164', e164: canonical };
  }
  return { status: 'invalid' };
}

/**
 * Website path: the country was selected, so the local field may still carry
 * a trunk 0. Chat never calls this until the person has named a country.
 *
 * @param {string} callingCode digits, no plus
 * @param {string} local the part after the country code, as typed
 * @returns {string} E.164 digits, or empty when the result is not a phone
 */
function composePhoneE164(callingCode, local) {
  const code = String(callingCode || '').replace(/\D/g, '');
  const rest = String(local || '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');
  if (!code || !rest || code.length > 4) return '';
  const e164 = code + rest;
  if (e164.length < PHONE_MIN_DIGITS || e164.length > PHONE_MAX_DIGITS) return '';
  if (e164.startsWith('0')) return '';
  return e164;
}

/**
 * Join a calling code to a national number, unless those digits already
 * start with that code and the rest is a full subscriber number.
 * 1 plus 2025550100 becomes 12025550100. 1 plus 12025550100 stays
 * 12025550100. 86 plus 13812345678 becomes 8613812345678.
 * A saved +1 never gains a second 1. 13800138000 stays unresolved so the
 * caller asks, instead of becoming 113800138000.
 * A 9-digit Flizy number never reaches here: interpretPhoneInput rejects it.
 * @param {string} callingCode
 * @param {string} national
 * @returns {string}
 */
function applySavedCallingCode(callingCode, national) {
  const code = normalizeCallingCode(callingCode);
  const digits = String(national || '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');
  if (!code || !digits) return '';
  // +1 is 1 plus a 10-digit NANP subscriber, nothing else. An 11-digit
  // number that already has that shape is kept. A 10-digit subscriber is
  // prefixed. A number that merely starts with 1 is not rewritten.
  if (code === '1') {
    if (digits.startsWith('1')) {
      const rest = digits.slice(1);
      if (rest.length === 10 && /^[2-9]\d{2}[2-9]\d{6}$/.test(rest)) return digits;
      return '';
    }
    return composePhoneE164('1', digits);
  }
  if (digits.startsWith(code) && digits.length > code.length) {
    const rest = digits.slice(code.length);
    const already = rest.length >= 10 && rest.length <= 12 && !rest.startsWith('0');
    const kept = code + rest;
    if (
      already &&
      kept.length >= PHONE_MIN_DIGITS &&
      kept.length <= PHONE_MAX_DIGITS &&
      !kept.startsWith('0')
    ) {
      return kept;
    }
  }
  return composePhoneE164(code, digits);
}

/**
 * True when a saved +1 must not decide this number.
 * Chinese mobiles are 11 digits starting with 13 through 19. The same
 * digits can be a +1 number, so the person has to say which country.
 * An explicit "united states" or "china" answer still resolves.
 * @param {string} callingCode
 * @param {string} national
 * @returns {boolean}
 */
function savedPlusOneMustAsk(callingCode, national) {
  const code = normalizeCallingCode(callingCode);
  const digits = String(national || '')
    .replace(/\D/g, '')
    .replace(/^0+/, '');
  return code === '1' && /^1[3-9]\d{9}$/.test(digits);
}

/**
 * The question asked when a send or request names a national number.
 * @returns {string}
 */
function phoneCountryPrompt() {
  const lines = [
    'Which country is this number from?',
    '',
    'Phone numbers need a country code.',
    '',
  ];
  PHONE_COUNTRY_CHOICES.forEach((choice, index) => {
    lines.push(`${index + 1}. ${choice.label}`);
  });
  lines.push('', 'Or enter the full number:', PHONE_EXAMPLE_LOCAL);
  return lines.join('\n');
}

/**
 * Turn the reply to phoneCountryPrompt into E.164 digits.
 *
 * 1, 2 and 3 are the listed countries. A single other digit is not a calling
 * code. A country name, a calling code (+234, 44, +1) or a full international
 * number also work. Anything else is empty, and the caller asks again.
 *
 * @param {string} raw
 * @param {string} national subscriber digits already stripped of the trunk 0
 * @returns {string}
 */
function resolvePhoneCountryAnswer(raw, national) {
  const text = String(raw || '')
    .trim()
    .replace(/\.$/, '');
  const lower = text.toLowerCase();
  if (!lower) return '';

  if (/^[1-9]$/.test(lower)) {
    const choice = PHONE_COUNTRY_CHOICES[Number(lower) - 1];
    return choice ? applySavedCallingCode(choice.callingCode, national) : '';
  }

  const read = interpretPhoneInput(text);
  if (read.status === 'e164') return read.e164;

  const code = lookupCallingCode(text);
  if (!code) return '';
  return applySavedCallingCode(code, national);
}

/**
 * @param {string} national
 * @returns {Error & { code: string, national: string }}
 */
function phoneNeedsCountryError(national) {
  const err = new Error(
    `Phone number needs a country code. Use the international format, e.g. ${PHONE_EXAMPLE_LOCAL}`
  );
  err.code = 'PHONE_NEEDS_COUNTRY';
  err.national = national;
  return err;
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
  PHONE_MIN_DIGITS,
  PHONE_MAX_DIGITS,
  PHONE_EXAMPLE_LOCAL,
  PHONE_EXAMPLE_E164,
  PHONE_EXAMPLE_COMMAND,
  PHONE_COUNTRY_CHOICES,
  normalizeCallingCode,
  lookupCallingCode,
  lookupCountry,
  countryByIso,
  countryFlag,
  describeCallingCode,
  callingCodeOptions,
  normalizePhoneNumber,
  isPlausiblePhone,
  interpretPhoneInput,
  composePhoneE164,
  applySavedCallingCode,
  savedPlusOneMustAsk,
  phoneCountryPrompt,
  resolvePhoneCountryAnswer,
  phoneNeedsCountryError,
  claimMatchKeys,
  claimMatchKeysForAccount,
  maskPhone,
};
