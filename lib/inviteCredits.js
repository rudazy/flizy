/**
 * What a counted invite is worth.
 *
 * Credits are DERIVED, never stored. `invite_attributions.counted_at` is the
 * record -- one row per invitee, stamped once, never re-stamped -- and
 * `invite_events` is the append-only trail behind it (ATTRIBUTED, ONBOARDED,
 * FIRST_TX, COUNTED, COUNT_REJECTED). A credits table would be a third copy of
 * one fact, and this repo has been bitten twice by two stores disagreeing.
 * Build a real ledger only when one of these becomes true:
 *   - credits can come from something other than a counted invite, or
 *   - a counted invite can be reversed and needs a compensating entry.
 *
 * WHERE THE FREEZE IS STATED: the public docs page, and nowhere else. See
 * web/app/docs/page.tsx, Invites section -- "Credit is a recorded number. It
 * is not money, it is separate from your wallet balance, and it is not
 * spendable yet." The screens deliberately say none of that: the dashboard
 * shows a cell labelled `Credit` beside the on-chain balance, which is how
 * the owner wants it read.
 *
 * So that docs paragraph is load-bearing, and it is the ONLY thing separating
 * this from accounts.balance_eth (lib/credit.js) -- also called credit, also
 * shown to the same user, but spendable and able to pay for sends. If that
 * paragraph is ever deleted or reworded away, nothing tells the two apart.
 *
 * Mirrored in web/lib/inviteCredits.ts. test/inviteCredits.test.js pins both
 * sides to the same vectors.
 */

/** Credits earned per counted invite. The only place this rate is written. */
const CREDIT_PER_COUNTED_INVITE = 1;

/**
 * Recorded, never redeemable. No runtime branch reads this yet, on purpose: it
 * is the invariant the docs page states to users, and test/inviteCredits.test.js
 * asserts it, so turning credits on has to be a decision rather than an edit.
 */
const CREDITS_SPENDABLE = false;

/**
 * Credits for a number of counted invites.
 *
 * Anything that is not a whole positive number is 0 rather than NaN: this
 * number is rendered straight into chat and onto the dashboard, and "Credits:
 * NaN" is worse than "Credits: 0" for a reader either way.
 *
 * @param {number|string} counted
 * @returns {number}
 */
function creditsForCounted(counted) {
  const n = Number(counted);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n) * CREDIT_PER_COUNTED_INVITE;
}

module.exports = {
  CREDIT_PER_COUNTED_INVITE,
  CREDITS_SPENDABLE,
  creditsForCounted,
};
