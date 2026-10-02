/**
 * Content-Security-Policy for every response.
 *
 * The development bundle is compiled with eval-source-map. A script-src that
 * forbids eval makes the browser discard that bundle: the server HTML still
 * paints, but no event handler is attached, and a submit falls through to a
 * navigation that looks like a refresh. Production builds do not use eval, so
 * the deployed policy does not allow it.
 */

export function sentryIngestOrigin(dsn) {
  const value = String(dsn || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    // A javascript: or data: value parses, and its origin is the literal
    // "null", which would be emitted into connect-src as a bare token. An
    // http: value would name a plaintext endpoint inside a policy that ends
    // in upgrade-insecure-requests.
    if (url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function contentSecurityPolicy({ dev, dsn }) {
  const sentryOrigin = sentryIngestOrigin(dsn);
  const scriptSrc = [
    "script-src 'self' 'unsafe-inline'",
    dev ? "'unsafe-eval'" : '',
    'https://www.googletagmanager.com https://www.clarity.ms',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    // 'unsafe-inline' is required by Next's inline bootstrap and the gtag/clarity snippets.
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    // https: because NFT art lives on whatever host each collection's metadata
    // names (web/lib/nftIndex.ts safeImageUrl). Images cannot run script, and
    // http is still refused by upgrade-insecure-requests below.
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' https://www.google-analytics.com https://*.clarity.ms${
      sentryOrigin ? ` ${sentryOrigin}` : ''
    }`,
    "manifest-src 'self'",
    "worker-src 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}
