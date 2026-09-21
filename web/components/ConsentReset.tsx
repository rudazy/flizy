'use client';

import { CONSENT_COOKIE } from '../lib/consent';

/**
 * Withdraw or change an analytics choice.
 *
 * The banner only appears while no choice is stored, so without this a yes
 * would be permanent for six months and there would be no way back. Clearing
 * the cookie puts the visitor back in front of the banner, which is the same
 * control they answered the first time.
 *
 * Expiring the cookie rather than deleting a client-side value is what makes
 * the reset real: the server reads that cookie to decide whether to emit the
 * trackers, so the reload comes back without them.
 */
export function ConsentReset() {
  function reset() {
    document.cookie = `${CONSENT_COOKIE}=; path=/; max-age=0; samesite=lax`;
    window.location.reload();
  }

  return (
    <button type="button" className="btn" onClick={reset}>
      Change my analytics choice
    </button>
  );
}
