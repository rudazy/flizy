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

export function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) {
    return process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
  }
  const normalized = origin.replace(/\/$/, '');
  return allowedOrigins().includes(normalized);
}

export function rejectIfCrossOrigin(req: Request): Response | null {
  if (isAllowedOrigin(req)) return null;
  return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
}
