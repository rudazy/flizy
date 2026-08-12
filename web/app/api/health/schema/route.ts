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
 */

import { timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';

import { checkSchema } from '@/lib/schemaGuard.mjs';
import { getSupabase } from '@/lib/supabase.ts';
import manifest from '@/lib/generated/schemaManifest.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Constant time compare. Returns false when no token is configured. */
function tokenMatches(offered: string | null): boolean {
  const expected = process.env.SCHEMA_HEALTH_TOKEN;
  if (!expected || !offered) return false;
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  let result;
  try {
    result = await checkSchema(getSupabase(), manifest as never);
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
  }

  return NextResponse.json(body, {
    status: result.ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
