/**
 * Post-login redirect. Only Flizy paths, never a protocol-relative URL.
 */

const FALLBACK = '/dashboard';

export function safeNext(raw: string | null | undefined, fallback = FALLBACK): string {
  if (!raw) return fallback;
  let decoded = String(raw);
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return fallback;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\')) {
    return fallback;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return fallback;

  const pathname = decoded.split('?')[0].split('#')[0];
  const profile = /^\/u\/([^/]+)$/.exec(pathname);
  const ok =
    pathname === '/dashboard' ||
    pathname.startsWith('/dashboard/') ||
    pathname.startsWith('/pay/') ||
    pathname.startsWith('/claim/') ||
    pathname === '/people' ||
    Boolean(profile && /^[a-z][a-z0-9]{2,23}$/.test(profile[1]));
  return ok ? decoded : fallback;
}
