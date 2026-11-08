/**
 * Payments that may only go through their own permission sender: Flizy Pay API
 * payouts and their claim holds (lib/api/payoutWorker.js). The executors in
 * this folder take `permission: { send, ownerKey }`; with ownerKey false a
 * payment that the sender does not take (no allowance, over what is left
 * today, an NFT, a wallet that cannot hold an allowance) is refused with
 * nothing sent. It never falls back to the owner key and never waits for a
 * passkey.
 */

const ALLOWANCE_REASON = 'ALLOWANCE';
const ALLOWANCE_REFUSAL = 'The payout allowance does not cover this payment. Nothing was sent.';

/** True when the caller allows only its own permission sender. */
function allowanceOnly(permission) {
  return Boolean(permission && permission.ownerKey === false);
}

module.exports = { ALLOWANCE_REASON, ALLOWANCE_REFUSAL, allowanceOnly };
