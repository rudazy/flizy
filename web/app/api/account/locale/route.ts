/**
 * Set preferred UI language for the signed-in account.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { toPublicAccount } from '../../../../lib/publicAccount';
import { isLocaleCode, normalizeLocale } from '../../../../lib/locale';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/account/locale';

const ACCOUNT_SELECT =
  'email, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth, unlock_pin_hash, daily_send_limit_eth';

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const raw = String(body.locale || '').trim().toLowerCase();
    if (!isLocaleCode(raw)) {
      return NextResponse.json(
        { error: 'Unsupported language. Use en, ko, or zh.' },
        { status: 400 }
      );
    }
    const locale = normalizeLocale(raw);

    const supabase = getSupabase();
    const { data: updated, error } = await supabase
      .from('accounts')
      .update({ locale })
      .eq('id', accountId)
      .select(ACCOUNT_SELECT)
      .single();

    if (error) {
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    return NextResponse.json({ account: toPublicAccount(updated) });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
