/**
 * The Developers section of Account: the approved platform behind this account
 * and its API keys (prefixes only; secrets are never stored to return). 404 for
 * an account Flizy has not approved, which is what hides the section.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { apiErrorBody } from '../../../lib/apiError';
import { listKeys, platformForAccount } from '../../../lib/apiPlatforms.ts';
import { payoutsEnabled, serverApiMode } from '../../../lib/apiAuth.ts';

const ROUTE = 'GET /api/developers';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const db = getSupabase();
    const platform = await platformForAccount(db, accountId);
    if (!platform) return NextResponse.json({ error: 'Not an approved platform' }, { status: 404 });
    const [keys, payouts] = await Promise.all([listKeys(db, platform.id), payoutsEnabled(db)]);
    return NextResponse.json(
      {
        platform: {
          name: platform.display_name,
          wallet: platform.wallet_address,
          enabled: platform.enabled,
          feeBps: platform.fee_bps,
          claimExpiryDays: platform.claim_expiry_default_days,
          claimExpiryMaxDays: platform.claim_expiry_max_days,
        },
        mode: serverApiMode(),
        payoutsEnabled: payouts,
        keys,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
