/**
 * Link code generation.
 *
 * A link code binds a chat channel to an account, so guessing one attaches your
 * own WhatsApp or Telegram to somebody else's money. It is a credential and is
 * sized like one.
 *
 * This used to be `randomBytes(4).toString('hex').toUpperCase().slice(0, 8)`.
 * The slice was a no-op (4 bytes of hex is already 8 characters), so the code
 * carried 32 bits. Now it is 10 characters of a 32 character alphabet, which is
 * exactly 50 bits.
 *
 * Alphabet: Crockford base32, so 0/O and 1/I/L can never be confused because
 * only one of each pair exists. 32 divides 256 evenly, so a byte taken mod 32 is
 * perfectly uniform and no rejection sampling is needed for an unbiased code.
 * Uppercase alphanumeric keeps the existing link_codes_code_format check
 * (^[A-Z0-9]{6,12}$) satisfied.
 *
 * Keep the generator here and in web/lib/linkCode.ts identical: the site issues
 * codes and the bot consumes them. test/linkCode.test.js fails if they drift.
 */

const crypto = require('crypto');

/** Crockford base32: digits and letters minus I, L, O and U. Exactly 32 chars. */
const LINK_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 chars of a 32 char alphabet = 50 bits. Still short enough to type. */
const LINK_CODE_LENGTH = 10;

/** Exact, not approximate: the alphabet is a power of two. */
const LINK_CODE_ENTROPY_BITS = LINK_CODE_LENGTH * Math.log2(LINK_CODE_ALPHABET.length);

/**
 * @returns {string} a fresh link code
 */
function generateLinkCode() {
  const bytes = crypto.randomBytes(LINK_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    out += LINK_CODE_ALPHABET[bytes[i] % LINK_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Enough of a code to correlate log lines, not enough to reuse one.
 * Attempts are logged, and a log that prints the credential in full hands a
 * reader of the journal somebody else's link.
 *
 * @param {string} code
 */
function maskLinkCode(code) {
  const s = String(code || '').trim();
  if (!s) return 'none';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(s.length - 4)}${s.slice(-2)}`;
}

module.exports = {
  LINK_CODE_ALPHABET,
  LINK_CODE_LENGTH,
  LINK_CODE_ENTROPY_BITS,
  generateLinkCode,
  maskLinkCode,
};
