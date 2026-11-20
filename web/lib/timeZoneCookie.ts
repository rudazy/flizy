/**
 * The browser's time zone, handed to the server for the sign-in list.
 *
 * Set on the login and signup screens so it is already there when any sign-in
 * finishes, including Continue with Google, which ends on a redirect that
 * carries no form body. Read once by createSession. It holds an IANA zone name
 * such as Africa/Lagos and nothing else.
 */

export const TIME_ZONE_COOKIE = 'flizy_tz';

const MAX_AGE_S = 30 * 24 * 60 * 60;

/** Browser only. Does nothing when the zone cannot be read. */
export function rememberTimeZone(): void {
  if (typeof document === 'undefined') return;
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return;
  }
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(zone)) return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; Path=/; Max-Age=${MAX_AGE_S}; SameSite=Lax${secure}`;
}
