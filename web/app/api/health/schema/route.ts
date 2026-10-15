/**
 * Post-deploy schema check.
 *
 * The build gate proves the schema was right at build time. This proves it is
 * still right now, which is the one thing a build time check cannot do.
 *
 * Object names are withheld by default. The schema shape is not secret exactly,
 * but it is more than an anonymous caller needs, so the public response is a
 * count. Set SCHEMA_HEALTH_TOKEN and send it as x-schema-health-token to get the
 * detail; leave it unset and no caller can.
 *
 * Exposure (what anon, authenticated or PUBLIC can reach) is never part of the
 * public answer: ok and the status code cover presence only, so this route
 * cannot advertise a hole. The token holder gets the exposure findings too.
 */

import { NextResponse } from 'next/server';

import { secretMatches } from '@/lib/bearerSecret';
import { checkSchema } from '@/lib/schemaGuard.mjs';
import { getSupabase } from '@/lib/supabase.ts';
import manifest from '@/lib/generated/schemaManifest.json';
import allowlist from '@/lib/schemaExposureAllowlist.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Constant time compare over hashes, so a wrong guess learns nothing about
 * the token's length either. Returns false when no token is configured.
 */
function tokenMatches(offered: string | null): boolean {
  return secretMatches(offered, process.env.SCHEMA_HEALTH_TOKEN);
}

export async function GET(request: Request) {
  let result;
  try {
    result = await checkSchema(getSupabase(), manifest as never, allowlist);
  } catch {
    // Never surface the underlying message: it can carry connection detail.
    return NextResponse.json({ ok: false, error: 'check_failed' }, { status: 503 });
  }

  const body: Record<string, unknown> = {
    ok: result.ok,
    surface: result.surface,
    checked: result.checked,
    missing: result.missing.length,
  };

  if (tokenMatches(request.headers.get('x-schema-health-token'))) {
    // requiredBy is withheld even here: it is a source path, not operator detail.
    body.detail = result.missing.map((object) => ({
      kind: object.kind,
      name: object.name,
      providedBy: object.providedBy,
    }));
    body.exposure = result.exposure
      ? {
          unavailable: result.exposure.unavailable,
          findings: result.exposure.findings,
          allowlisted: result.exposure.allowlisted.length,
        }
      : null;
  }

  return NextResponse.json(body, {
    status: result.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
