/**
 * The Developers section of Account: the approved platform behind this account,
 * its API keys (prefixes only; secrets are never stored to return), the payout
 * limits Flizy set per asset, the live payout allowance, the latest payouts and
 * payments, the sites checkouts may return to, the webhook endpoints (never
 * their secrets) and the latest deliveries. 404
 * for an account Flizy has not approved, which is what hides the section.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { apiErrorBody } from '../../../lib/apiError';
import { listKeys, platformForAccount } from '../../../lib/apiPlatforms.ts';
import { payoutsEnabled, serverApiMode } from '../../../lib/apiAuth.ts';
import { liveAllowances } from '../../../lib/apiAllowance.ts';
import { PAYOUT_ASSETS, PAYOUT_COLUMNS, payoutView, plainAmount, type PayoutRow, type PayoutSymbol } from '../../../lib/apiPayouts.ts';
import { listDeliveries, listEndpoints } from '../../../lib/apiWebhooks.ts';
import { PAYMENT_COLUMNS, listOrigins, paymentView, type PaymentRow } from '../../../lib/apiPayments.ts';
import { siteOrigin } from '../../../lib/siteOrigin';

const ROUTE = 'GET /api/developers';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const db = getSupabase();
    const platform = await platformForAccount(db, accountId);
    if (!platform) return NextResponse.json({ error: 'Not an approved platform' }, { status: 404 });
    const [keys, payouts, allowances, limitsRes, recentRes, endpoints, deliveries, paymentsRes, origins] = await Promise.all([
      listKeys(db, platform.id),
      payoutsEnabled(db),
      liveAllowances(db, platform.id),
      db.from('api_platform_limits').select('symbol, max_payout, daily_max').eq('platform_id', platform.id),
      db.from('api_transactions').select(PAYOUT_COLUMNS).eq('platform_id', platform.id).eq('kind', 'payout').order('created_at', { ascending: false }).limit(20),
      listEndpoints(db, platform.id),
      listDeliveries(db, platform.id, 20),
      db.from('api_transactions').select(PAYMENT_COLUMNS).eq('platform_id', platform.id).eq('kind', 'payment').order('created_at', { ascending: false }).limit(20),
      listOrigins(db, platform.id),
    ]);
    if (limitsRes.error) throw new Error(limitsRes.error.message);
    if (recentRes.error) throw new Error(recentRes.error.message);
    if (paymentsRes.error) throw new Error(paymentsRes.error.message);
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
        payouts: ((recentRes.data as PayoutRow[]) || []).map(payoutView),
        endpoints,
        deliveries,
        payments: ((paymentsRes.data as PaymentRow[]) || []).map((r) => paymentView(r, siteOrigin())),
        origins,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
