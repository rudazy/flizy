/**
 * Link code generation (site copy).
 *
 * Kept byte-for-byte equivalent to lib/linkCode.js, which carries the full
 * reasoning: 10 characters of Crockford base32 is exactly 50 bits, the alphabet
 * has no confusable pairs, and 32 divides 256 so a byte mod 32 is unbiased.
 *
 * The dashboard generates codes through this module and the bot consumes them,
 * so the two must agree. test/linkCode.test.js compares both and fails on drift.
 */

import crypto from 'crypto';

/** Crockford base32: digits and letters minus I, L, O and U. Exactly 32 chars. */
export const LINK_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 chars of a 32 char alphabet = 50 bits. Still short enough to type. */
export const LINK_CODE_LENGTH = 10;

/** Exact, not approximate: the alphabet is a power of two. */
export const LINK_CODE_ENTROPY_BITS =
  LINK_CODE_LENGTH * Math.log2(LINK_CODE_ALPHABET.length);

export function generateLinkCode(): string {
  const bytes = crypto.randomBytes(LINK_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < LINK_CODE_LENGTH; i += 1) {
    out += LINK_CODE_ALPHABET[bytes[i] % LINK_CODE_ALPHABET.length];
  }
  return out;
}
