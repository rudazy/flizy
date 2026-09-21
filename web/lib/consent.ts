/**
 * Analytics consent.
 *
 * GA4 and Microsoft Clarity were loading for every visitor in production with
 * nothing asked. Both set cookies, and Clarity records a session replay, so
 * neither is the kind of thing that rides along on legitimate interest. Umami
 * is cookieless and would not need this, but it is configured through the same
 * component and there is no reason to hold it to a looser rule than the other
 * two.
 *
 * The choice is a cookie rather than localStorage because the decision has to
 * be made on the server: Analytics is a server component, and the point of this
 * is that the tracker never reaches the page at all before consent. A value
 * only the browser can see would mean shipping the scripts and hoping the
 * client suppressed them.
 *
 * The cookie itself is strictly necessary (it exists only to record a refusal)
 * and so is not gated on consent. It is deliberately readable by script: the
 * banner both writes and clears it.
 */

export const CONSENT_COOKIE = 'flizy_consent';

export const CONSENT_GRANTED = 'granted';
export const CONSENT_DENIED = 'denied';

export type ConsentChoice = typeof CONSENT_GRANTED | typeof CONSENT_DENIED;

/**
 * Six months. Long enough that a returning visitor is not asked every week,
 * short enough that a stale yes does not outlive the visit it was given for.
 */
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 182;

/**
 * Read a stored choice. Anything that is not exactly one of the two values,
 * including an absent cookie and a hand-edited one, reads as no choice made.
 * Undecided must never fall through to granted.
 */
export function readConsent(raw: string | undefined | null): ConsentChoice | null {
  if (raw === CONSENT_GRANTED) return CONSENT_GRANTED;
  if (raw === CONSENT_DENIED) return CONSENT_DENIED;
  return null;
}

/** True only for an explicit yes. */
export function analyticsAllowed(raw: string | undefined | null): boolean {
  return readConsent(raw) === CONSENT_GRANTED;
}
