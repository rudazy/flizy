/**
 * Funnel events for GA4 + Clarity.
 *
 * Two rules, both non-negotiable:
 *  1. Never pass PII. No email, wallet address, phone number, username, claim
 *     token or amount. Params describe the shape of an action, not who did it.
 *  2. Analytics must never break a money flow. Every call is wrapped and the
 *     helper no-ops when no tag is loaded (local dev, preview, blocked scripts).
 */

type FlizyEvent =
  /** Account created on the web. */
  | 'signup_completed'
  /** Returning user signed in. */
  | 'login_completed'
  /** One-time chat link code issued — the step before activation. */
  | 'link_code_generated'
  /** A destination was approved. Nothing can be sent before this happens. */
  | 'trusted_address_added'
  /** Held funds successfully redeemed on the web. */
  | 'claim_completed';

type EventParams = Record<string, string | number | boolean>;

type TagWindow = Window & {
  gtag?: (command: 'event', name: string, params?: EventParams) => void;
  clarity?: (command: 'event', name: string) => void;
};

export function track(event: FlizyEvent, params?: EventParams): void {
  if (typeof window === 'undefined') return;

  const w = window as TagWindow;
  try {
    w.gtag?.('event', event, params);
    // Clarity tags the session so recordings can be filtered by what happened.
    w.clarity?.('event', event);
  } catch {
    // Swallow deliberately: a blocked or half-loaded tag must not surface to the user.
  }
}
