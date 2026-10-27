/**
 * Sentences for a Google sign-in that did not open a session.
 * Unknown codes stay blank so a query string cannot write the page.
 */

const GOOGLE_LOGIN_ERRORS: Record<string, string> = {
  unavailable: 'Google sign-in is not set up on this server yet.',
  cancelled: 'Google sign-in was cancelled.',
  expired: 'That Google sign-in expired. Try again.',
  failed: 'Google sign-in did not finish. Try again.',
  no_account: 'No Flizy account uses that Google email. Create an account with it first.',
  unverified: 'Finish the email code for that account, then Google can sign you in.',
  limited: 'Too many Google sign-in attempts. Try again in a while.',
};

export function googleLoginError(code: string | null | undefined): string {
  if (!code) return '';
  return GOOGLE_LOGIN_ERRORS[code] || '';
}
