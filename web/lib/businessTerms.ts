/**
 * The business terms an account accepts to turn on Account > Business.
 *
 * Plain words, one point per line. Any change to what they say is a new
 * version: an account accepted the version it saw, and turning business on
 * again takes the current one. The 0.5% and the $0.01 are FEE_MERCHANT_BPS and
 * FEE_MERCHANT_MIN_USD (web/lib/fees.ts, defaults 50 and 0.01); changing either
 * needs a new version of these terms.
 */

export const BUSINESS_TERMS_VERSION = '2026-11-16-2';

export const BUSINESS_TERMS: readonly string[] = Object.freeze([
  'Flizy keeps 0.5% of each payment you receive while Business is on, and at least $0.01 on a payment. You get the rest.',
  'People who pay you pay the price you ask. They pay no fee.',
  'The fee applies to payments sent to you in chat, through your pay link, and for your requests and pots. Checkout payments are not charged for now.',
  'Your history shows each payment, what Flizy kept, and what you received.',
  'You can turn Business off at any time. Payments after that are not charged. Fees already taken are not refunded.',
  'While Flizy runs on a test network, payments and fees are in test tokens, not real money.',
]);

/**
 * A short heading for each line above, in the same order, for Account >
 * Business. A heading only names its line: what is agreed is the line itself,
 * so a heading can change without a new version.
 */
export const BUSINESS_TERM_HEADINGS: readonly string[] = Object.freeze([
  'Our fee',
  'No fees for your customers',
  'Where it applies',
  'Transparent history',
  'Turn it off anytime',
  'Test network',
]);

/** The fee and its minimum, as the first line states them, for the summary at the top of the panel. */
export const BUSINESS_FEE_SUMMARY = Object.freeze({ fee: '0.5%', minimum: '$0.01' });

/** Whether a version the browser sent is the current one. */
export function isCurrentBusinessTerms(version: unknown): boolean {
  return typeof version === 'string' && version === BUSINESS_TERMS_VERSION;
}
