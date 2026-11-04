/**
 * Email platform owners about API key events not mailed yet.
 *
 * Key changes made on the site are mailed at once by the route that made
 * them. A permission change Flizy makes in the database (granting payout) is
 * recorded by the api_key_events trigger but has no route to mail it, so the
 * WhatsApp bot calls this every few minutes (lib/apiKeyNotices.js). The caller
 * cannot choose who is mailed or what it says: only events the database
 * recorded are mailed, to the platform account's own email.
 *
 * Server to server: a bearer secret (SECURITY_MAIL_SECRET), checked before
 * anything else. Unset refuses every caller.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody } from '@/lib/apiError';
import { bearerMatches } from '@/lib/bearerSecret';
import { getSupabase } from '@/lib/supabase.ts';
import { siteOrigin } from '@/lib/siteOrigin';
import { mailOwner } from '@/lib/securityNotice';
import { mailKeyEvents } from '@/lib/apiPlatforms.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = 'POST /api/internal/api-key-notices';
const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(req: Request) {
  if (!bearerMatches(req.headers.get('authorization'), process.env.SECURITY_MAIL_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  }
  // The body carries nothing; read and drop it so the request is complete.
  await req.json().catch(() => null);
  try {
    const db = getSupabase();
    const sent = await mailKeyEvents(db, (id, mail) => mailOwner(db, id, mail), siteOrigin(), { limit: 50 });
    return NextResponse.json({ ok: true, sent }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500, headers: NO_STORE });
  }
}
