/**
 * The Developers section of Account: the approved platform behind this account,
 * its API keys (prefixes only; secrets are never stored to return), the payout
 * limits Flizy set per asset, and the live payout allowance. 404 for an account
 * Flizy has not approved, which is what hides the section.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { apiErrorBody } from '../../../lib/apiError';
import { listKeys, platformForAccount } from '../../../lib/apiPlatforms.ts';
import { payoutsEnabled, serverApiMode } from '../../../lib/apiAuth.ts';
import { liveAllowances } from '../../../lib/apiAllowance.ts';
import { PAYOUT_ASSETS, plainAmount, type PayoutSymbol } from '../../../lib/apiPayouts.ts';

const ROUTE = 'GET /api/developers';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const db = getSupabase();
    const platform = await platformForAccount(db, accountId);
    if (!platform) return NextResponse.json({ error: 'Not an approved platform' }, { status: 404 });
    const [keys, payouts, allowances, limitsRes] = await Promise.all([
      listKeys(db, platform.id),
      payoutsEnabled(db),
      liveAllowances(db, platform.id),
      db.from('api_platform_limits').select('symbol, max_payout, daily_max').eq('platform_id', platform.id),
    ]);
    if (limitsRes.error) throw new Error(limitsRes.error.message);
    const show = (symbol: string, raw: string) => {
      const a = PAYOUT_ASSETS[symbol as PayoutSymbol];
      return a ? `${plainAmount(BigInt(raw), a.decimals)} ${a.label}` : raw;
    };
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
        limits: (limitsRes.data || []).map((l) => ({ symbol: l.symbol, maxPayout: show(l.symbol, l.max_payout), dailyMax: show(l.symbol, l.daily_max) })),
        allowances: allowances.map((a) => ({ symbol: a.symbol, perDay: show(a.symbol, a.periodAmount), expiresAt: a.expiresAt })),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
