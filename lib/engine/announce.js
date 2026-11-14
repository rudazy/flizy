/**
 * The "money is moving" notice, said once, at the moment money can actually
 * move: after every check, and after the over-cap decision, so a payment that
 * is refused or waits for a passkey is never announced as being sent. A notice
 * that fails never stops the payment.
 *
 * Used by chat sends (./executeTransfer.js), claim holds (./executeClaim.js)
 * and chat checkout payments (lib/api/checkoutPay.js).
 */

const { publicErrorMessage } = require('../sanitize');

function announcer(onSending) {
  let done = false;
  return async () => {
    if (done || typeof onSending !== 'function') return;
    done = true;
    try {
      await onSending();
    } catch (err) {
      console.warn('send notice failed:', publicErrorMessage(err));
    }
  };
}

module.exports = { announcer };
