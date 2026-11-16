/**
 * The business terms an account accepts to turn on Account > Business.
 *
 * Plain words, one point per line. Any change to what they say is a new
 * version: an account accepted the version it saw, and turning business on
 * again takes the current one. The 1% is FEE_MERCHANT_BPS (web/lib/fees.ts,
 * default 100); changing that setting needs a new version of these terms.
 */

export const BUSINESS_TERMS_VERSION = '2026-11-16';

export const BUSINESS_TERMS: readonly string[] = Object.freeze([
  'Flizy keeps 1% of each payment you receive while Business is on. You get the other 99%.',
  'People who pay you pay the price you ask. They pay no fee.',
  'The 1% applies to payments sent to you in chat, through your pay link, and for your requests and pots. Checkout payments are not charged for now.',
  'Your history shows each payment, what Flizy kept, and what you received.',
  'You can turn Business off at any time. Payments after that are not charged. Fees already taken are not refunded.',
  'While Flizy runs on a test network, payments and fees are in test tokens, not real money.',
]);

/** Whether a version the browser sent is the current one. */
export function isCurrentBusinessTerms(version: unknown): boolean {
  return typeof version === 'string' && version === BUSINESS_TERMS_VERSION;
}
