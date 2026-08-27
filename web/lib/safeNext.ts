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
  const ok =
    pathname === '/dashboard' ||
    pathname.startsWith('/dashboard/') ||
    pathname.startsWith('/pay/') ||
    pathname.startsWith('/claim/');
  return ok ? decoded : fallback;
}
