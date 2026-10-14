/**
 * Send a schema check failure to Sentry as an error under one fixed tag, so a
 * single alert rule covers the bots, the cold start check and the daily check.
 *
 * alert=schema_exposure is what the bots send too (lib/sentry.js). Each
 * source groups into its own issue through the fingerprint, and the source
 * tag says which one fired.
 *
 * A no-op when Sentry was not initialised (no DSN, or not production), which
 * instrumentation-node.ts decides. Flushes before returning, because a
 * serverless function can be frozen as soon as its response is sent.
 */

import * as Sentry from '@sentry/nextjs';

import { EXPOSURE_ALERT_TAG } from './schemaGuard.mjs';

export async function reportSchemaExposure(message: string, source: string): Promise<void> {
  const [headline] = message.split('\n');
  Sentry.captureException(new Error(headline), {
    level: 'error',
    tags: { alert: EXPOSURE_ALERT_TAG, source },
    fingerprint: [EXPOSURE_ALERT_TAG, source],
    extra: { report: message },
  });
  await Sentry.flush(2000);
}
