/**
 * The node-runtime half of the cold start schema check. See instrumentation.ts
 * for why this is a separate module.
 *
 * It deliberately never throws. Throwing here takes down every route, including
 * the ones that do not touch the missing object, which is a worse outcome than
 * the drift it would be reporting. Observability, not enforcement: promoting it
 * to a hard failure means first deciding what a half broken site should do.
 */

import * as Sentry from '@sentry/nextjs';
import { checkSchema } from './lib/schemaGuard.mjs';
import { getSupabase } from './lib/supabase.ts';
import manifest from './lib/generated/schemaManifest.json';
import { scrubEvent } from './lib/errorScrub';

/**
 * Error reporting, off unless a DSN is configured in production.
 *
 * Absence of SENTRY_DSN is the off switch, so a preview deployment or a local
 * run cannot post to a third party by forgetting something. `sendDefaultPii` is
 * off and every event goes through the scrubber, because the interesting PII in
 * this app arrives inside error messages rather than in tidy named fields.
 * Tracing is off: sampling real requests is more data leaving for less benefit
 * than a money app should accept by default.
 */
/**
 * Same reasoning as instrumentation-client.ts: a Vercel preview builds with
 * NODE_ENV=production and inherits the production variables, so without this
 * a preview error arrives tagged `production`. An explicit override wins.
 */
function sentryEnvironment(): string {
  const explicit = (process.env.SENTRY_ENVIRONMENT || '').trim();
  if (explicit) return explicit;
  return (process.env.VERCEL_ENV || '').trim() || 'production';
}

if (process.env.SENTRY_DSN && process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: sentryEnvironment(),
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event) as never,
    beforeBreadcrumb: () => null,
    initialScope: { tags: { service: 'flizy-web' } },
  });
}

const result = await checkSchema(getSupabase(), manifest as never).catch((err: unknown) => ({
  ok: false,
  surface: 'web',
  checked: 0,
  missing: [],
  // Never let the check itself break a boot it was only observing.
  message: `cold start check did not run: ${err instanceof Error ? err.message : String(err)}`,
}));

if (result.ok) {
  console.log(`[schema-guard] ${result.checked} objects present (${result.surface}).`);
} else {
  console.error(`[schema-guard] ${result.message}`);
}
