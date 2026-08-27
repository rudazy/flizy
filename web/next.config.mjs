/** @type {import('next').NextConfig} */

/**
 * Content Security Policy.
 *
 * Enforced. 'unsafe-inline' remains because Next's bootstrap and gtag/clarity
 * snippets still inject scripts. That does not stop a determined XSS, but
 * object-src, base-uri, form-action and frame-ancestors now bind.
 *
 * frame-ancestors 'none' is the CSP equivalent of X-Frame-Options: DENY. Both are
 * sent — older browsers honour only the latter.
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  // 'unsafe-inline' is required by Next's inline bootstrap and the gtag/clarity snippets.
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.clarity.ms",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://www.googletagmanager.com https://c.clarity.ms",
  "font-src 'self' data:",
  "connect-src 'self' https://www.google-analytics.com https://*.clarity.ms",
  "manifest-src 'self'",
  "worker-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  },
  // Vercel terminates TLS, so asserting HSTS here is safe.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig = {
  reactStrictMode: true,
  // Required on Next 14 for instrumentation.ts. Runs the cold start schema
  // check once per server instance, not per request.
  experimental: { instrumentationHook: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
