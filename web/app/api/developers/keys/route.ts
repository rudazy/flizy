/**
 * Create an API key for this account's approved platform. Takes the account
 * password: a key is a credential for the account's money, so a stolen session
 * cookie alone must not be enough to mint one. Permissions `read` and `collect`
 * only; `payout` is granted by Flizy. The secret is in this response and
 * nowhere else, ever.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../lib/apiError';
import { cleanIpAllowlist, cleanScopes } from '../../../../lib/apiKeys.ts';
import { createKey, KeyRequestError, mailKeyEvents, platformForAccount } from '../../../../lib/apiPlatforms.ts';
import { serverApiMode } from '../../../../lib/apiAuth.ts';
import { mailOwner } from '../../../../lib/securityNotice';
import { siteOrigin } from '../../../../lib/siteOrigin';

const ROUTE = 'POST /api/developers/keys';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const db = getSupabase();
    const auth = await requirePassword(db, accountId, String(body.password || ''), 'create an API key');
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    const platform = await platformForAccount(db, accountId);
    if (!platform) return NextResponse.json({ error: 'Not an approved platform' }, { status: 404 });
    if (!platform.enabled) return NextResponse.json({ error: 'This platform is paused by Flizy.' }, { status: 403 });

    const scopes = cleanScopes(body.scopes);
    if (!scopes) return NextResponse.json({ error: 'Choose read and/or collect. Payout is granted by Flizy.' }, { status: 400 });
    const ipAllowlist = cleanIpAllowlist(body.ipAllowlist);
    if (!ipAllowlist) return NextResponse.json({ error: 'The IP allowlist takes up to 20 IPv4 or IPv6 addresses.' }, { status: 400 });

    const made = await createKey(db, platform, {
      label: String(body.label || ''),
      scopes,
      ipAllowlist,
      mode: serverApiMode(),
    });
    await mailKeyEvents(db, (id, mail) => mailOwner(db, id, mail), siteOrigin(), { platformId: platform.id }).catch(() => 0);
    return NextResponse.json({ key: made.key, secret: made.secret }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof KeyRequestError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
