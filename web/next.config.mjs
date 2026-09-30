// From /config, not the package root: the root re-export is deprecated and
// stops working in v11.
import { withSentryConfig } from '@sentry/nextjs/config';
import { contentSecurityPolicy } from './lib/contentSecurityPolicy.mjs';

/** @type {import('next').NextConfig} */

/**
 * Enforced. frame-ancestors 'none' is the CSP equivalent of X-Frame-Options:
 * DENY. Both are sent. Older browsers honour only the latter.
 *
 * No tunnelRoute. Naming the Sentry ingest host in connect-src is the
 * alternative to a public forwarder on this domain. The host is derived from
 * the DSN, so a deploy with no DSN keeps the previous connect-src.
 */
const csp = contentSecurityPolicy({
  dev: process.env.NODE_ENV !== 'production',
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || '',
});

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
