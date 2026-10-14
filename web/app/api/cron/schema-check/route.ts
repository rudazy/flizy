/**
 * Daily schema check, run by Vercel Cron (web/vercel.json).
 *
 * The build gate checks the database at deploy time and the bots only report
 * at boot, so between deploys nothing else would notice a table created with
 * RLS off or a grant that drifted back. This runs the same check once a day
 * and sends any exposure to Sentry under alert=schema_exposure, the tag the
 * alert rule listens on. A presence failure, or a check that could not run, is
 * reported under the same tag: a watcher that is silently blind is the same
 * problem as a hole it would have caught.
 *
 * A run that never happens reports nothing, so every run also checks in with a
 * Sentry cron monitor (MONITOR_SLUG). Sentry raises its own issue when a
 * check-in is missed or marked error. Those issues come from the monitor, not
 * from this code, so they do not carry the alert tag; they are routed by the
 * monitor's own notification settings.
 *
 * Vercel sends CRON_SECRET as a bearer token on scheduled invocations. Without
 * CRON_SECRET set the route refuses every caller, and an unauthorised call
 * never checks in, so the heartbeat cannot be faked from outside. The response
 * never carries object names, only counts.
 */

import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { apiErrorBody } from '@/lib/apiError';
import { bearerMatches } from '@/lib/bearerSecret';
import { checkSchema } from '@/lib/schemaGuard.mjs';
import { getSupabase } from '@/lib/supabase.ts';
import manifest from '@/lib/generated/schemaManifest.json';
import allowlist from '@/lib/schemaExposureAllowlist.json';
import { reportSchemaExposure } from '@/lib/schemaExposureReport';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SOURCE = 'web-daily-check';

const MONITOR_SLUG = 'flizy-schema-daily-check';

/**
 * Sent with every check-in, so Sentry creates and keeps the monitor in step.
 * The schedule must match web/vercel.json; test/schemaGuard.test.js holds the
 * two together. checkinMargin and maxRuntime are minutes. The margin is wider
 * than an hour because Vercel Hobby only promises a daily cron runs somewhere
 * inside its scheduled hour; a 60 minute margin would flag a late but healthy
 * run as missed.
 */
const MONITOR_CONFIG = {
  schedule: { type: 'crontab', value: '0 7 * * *' },
  timezone: 'UTC',
  checkinMargin: 90,
  maxRuntime: 5,
  failureIssueThreshold: 1,
  recoveryThreshold: 1,
} as const;

/** The bearer token Vercel Cron sends, checked in constant time. */
function authorized(header: string | null): boolean {
  return bearerMatches(header, process.env.CRON_SECRET);
}

const NO_STORE = { 'cache-control': 'no-store' };

/** Close the check-in opened for this run and make sure it leaves the lambda. */
async function finishCheckIn(checkInId: string, ok: boolean, started: number): Promise<void> {
  Sentry.captureCheckIn(
    {
      checkInId,
      monitorSlug: MONITOR_SLUG,
      status: ok ? 'ok' : 'error',
      duration: (Date.now() - started) / 1000,
    },
    MONITOR_CONFIG
  );
  await Sentry.flush(2000);
}

export async function GET(request: Request) {
  if (!authorized(request.headers.get('authorization'))) {
    return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  }

  const started = Date.now();
  const checkInId = Sentry.captureCheckIn(
    { monitorSlug: MONITOR_SLUG, status: 'in_progress' },
    MONITOR_CONFIG
  );

  let result;
  try {
    result = await checkSchema(getSupabase(), manifest as never, allowlist);
  } catch (err) {
    // The detail goes to the function log only: it can carry connection detail.
    const body = apiErrorBody('GET /api/cron/schema-check', err);
    await reportSchemaExposure(
      'SCHEMA CHECK: the daily check could not run. See the function log for the cause.',
      SOURCE
    ).catch(() => {});
    await finishCheckIn(checkInId, false, started).catch(() => {});
    return NextResponse.json({ ok: false, ...body }, { status: 503, headers: NO_STORE });
  }

  const problems = [
    result.ok ? null : result.message,
    result.exposure ? result.exposure.message : null,
  ].filter((m): m is string => Boolean(m));

  if (problems.length) {
    await reportSchemaExposure(problems.join('\n\n'), SOURCE).catch(() => {});
  }
  await finishCheckIn(checkInId, problems.length === 0, started).catch(() => {});

  return NextResponse.json(
    {
      ok: problems.length === 0,
      missing: result.missing.length,
      exposed: result.exposure ? result.exposure.findings.length : null,
      allowlisted: result.exposure ? result.exposure.allowlisted.length : null,
    },
    { status: problems.length ? 503 : 200, headers: NO_STORE }
  );
}
