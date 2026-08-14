import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import {
  hasPaidMerchantBefore,
  isSavedMerchant,
  resolvePayRef,
} from '../../../../lib/payCode.ts';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'GET /api/pay/preview';

export async function GET(req: Request) {
  try {
    const payerId = await getAccountIdFromCookie();
    if (!payerId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const url = new URL(req.url);
    const merchant = await resolvePayRef(getSupabase(), url.searchParams.get('ref'));
    if (!merchant?.accountId) {
      return NextResponse.json({ error: 'Pay identity not found.' }, { status: 404 });
    }
    if (merchant.accountId === payerId) {
      return NextResponse.json({ self: true, firstPay: false, alreadySaved: false });
    }
    const supabase = getSupabase();
    const { data: dest } = await supabase
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', merchant.accountId)
      .maybeSingle();
    const to = dest?.agent_wallet_address || '';
    const firstPay = to ? !(await hasPaidMerchantBefore(supabase, payerId, to)) : true;
    const alreadySaved = to ? await isSavedMerchant(supabase, payerId, to) : false;
    return NextResponse.json({
      self: false,
      firstPay,
      alreadySaved,
      username: merchant.username,
      displayName: merchant.displayName,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
