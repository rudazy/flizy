/**
 * What a counted invite is worth (site half).
 *
 * Deliberate mirror of lib/inviteCredits.js -- the web bundle cannot reach into
 * the bot package, so the rule is written twice and pinned by
 * test/inviteCredits.test.js, which loads both and compares them on the same
 * vectors. Change one side, change the other, or that test fails.
 *
 * No imports on purpose, so node --test can load this file directly.
 *
 * Why credits are derived rather than stored, and why the freeze lives on the
 * docs page rather than under every number: see the header of
 * lib/inviteCredits.js.
 */

/** Credits earned per counted invite. The only place this rate is written. */
export const CREDIT_PER_COUNTED_INVITE = 1;

/** Recorded, never redeemable. Stated to users in web/app/docs/page.tsx. */
export const CREDITS_SPENDABLE = false;

/** Credits for a number of counted invites. Never NaN: bad input reads as 0. */
export function creditsForCounted(counted: number | string): number {
  const n = Number(counted);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n) * CREDIT_PER_COUNTED_INVITE;
}
