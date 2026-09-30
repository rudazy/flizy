/**
 * Same-site Origin check for cookie-authenticated money POSTs.
 *
 * SameSite=Lax already blocks most cross-site POSTs. This is the extra gate
 * for anything that still sends a cookie (old browsers, non-browser clients
 * that forge Origin). Fetch from flizy.app always includes Origin.
 *
 * Returns a Web Response, not NextResponse, so unit tests can load this
 * module without the Next server bundle.
 */

function isProd(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}

function allowedOrigins(): string[] {
  const raw = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.SITE_URL,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];
  return raw
    .filter((u): u is string => Boolean(u))
    .map((u) => String(u).replace(/\/$/, ''));
}

/**
 * The local dev server's own origin, on a development build only.
 *
 * The list above names port 3000. When the dev server runs on another port it
 * is started with PORT set, and that port (and only that port) is accepted on
 * localhost and 127.0.0.1. Any other local port is a different service, and
 * letting it post with the dev session's cookie would be CSRF from the same
 * machine.
 *
 * Production never takes this branch.
 */
function devServerOrigins(): string[] {
  const port = String(process.env.PORT || '3000').trim();
  if (!/^\d{1,5}$/.test(port)) return [];
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

export function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) {
    return !isProd();
  }
  const normalized = origin.replace(/\/$/, '');
  if (allowedOrigins().includes(normalized)) return true;
  return !isProd() && devServerOrigins().includes(normalized);
}

export function rejectIfCrossOrigin(req: Request): Response | null {
  if (isAllowedOrigin(req)) return null;
  return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
}
