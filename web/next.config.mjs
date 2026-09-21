// From /config, not the package root: the root re-export is deprecated and
// stops working in v11.
import { withSentryConfig } from '@sentry/nextjs/config';

/** @type {import('next').NextConfig} */

/**
 * Where the browser SDK is allowed to post.
 *
 * Derived from the DSN rather than hardcoded, because the ingest host carries
 * the org id and differs per project. With no DSN configured the origin is
 * empty and connect-src is left exactly as it was, so this cannot quietly
 * widen the policy on a deploy that is not running Sentry.
 *
 * The alternative Sentry offers is tunnelRoute, which proxies events through
 * this app's own domain and so needs no CSP entry. Not used: it would stand up
 * a public endpoint that forwards to a third party, and naming the host is the
 * more honest of the two.
 */
function sentryIngestOrigin() {
  const dsn = (process.env.NEXT_PUBLIC_SENTRY_DSN || '').trim();
  if (!dsn) return '';
  try {
    const url = new URL(dsn);
    // https only, for two reasons that both end in a worse header than no
    // header. A `javascript:` or `data:` value parses, and its origin is the
    // literal string "null", which would be emitted into connect-src as a bare
    // token. An `http:` value parses cleanly and would name a plaintext
    // endpoint inside a policy whose last directive is upgrade-insecure-requests.
    if (url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    // A malformed DSN must not take the build down over a header. The SDK will
    // refuse it too, so nothing is being hidden by carrying on.
    return '';
  }
}

const sentryOrigin = sentryIngestOrigin();

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
  `connect-src 'self' https://www.google-analytics.com https://*.clarity.ms${
    sentryOrigin ? ` ${sentryOrigin}` : ''
  }`,
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

/**
 * Sentry's build wrapper. Without it, instrumentation-client.ts is never added
 * to the client bundle and the browser half of error reporting silently does
 * not exist, which is the state this repo was in until now.
 *
 * Source map upload is tied to SENTRY_AUTH_TOKEN. With a token, client stack
 * traces are readable instead of minified; without one, uploading is switched
 * off rather than attempted, so a deploy that has not been given the token
 * builds clean instead of warning on every run. Reporting itself does not
 * depend on it.
 */
const hasUploadCredentials = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  sourcemaps: {
    disable: !hasUploadCredentials,
    // Explicit, not left to a default that merely warns. Next emits client maps
    // as hidden-source-map, so no sourceMappingURL points at them, but the .map
    // files still sit at guessable paths under /_next and would serve the whole
    // unminified source to anyone who asks. Uploaded, then removed from the
    // deployment.
    deleteSourcemapsAfterUpload: true,
  },
  // The wrapper otherwise prints a setup advert on every build.
  telemetry: false,
  // No tunnelRoute on purpose. See sentryIngestOrigin above for why the host is
  // named in connect-src instead.
  webpack: {
    treeshake: {
      removeDebugLogging: true,
      // Tracing is off in both init calls, so its code has no reason to be in
      // anyone's bundle.
      removeTracing: true,
    },
  },
});
