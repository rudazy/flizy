/**
 * Set or clear the optional calling code used when chat sees a local number.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { toPublicAccount } from '../../../../lib/publicAccount';
import { countryByIso, normalizeStoredCallingCode, SITE_PHONE_COUNTRIES } from '../../../../lib/phoneFormat';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/account/calling-code';

const ACCOUNT_SELECT_BASE =
  'email, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth, unlock_pin_hash, daily_send_limit_eth, default_calling_code';
const ACCOUNT_SELECT = `${ACCOUNT_SELECT_BASE}, default_country_iso`;

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const rawIso = body.countryIso == null ? '' : String(body.countryIso).trim();
    const rawCode = body.callingCode == null ? '' : String(body.callingCode).trim();
    let callingCode: string | null = null;
    let countryIso: string | null = null;
    if (rawIso) {
      const country = countryByIso(rawIso);
      if (!country) {
        return NextResponse.json(
          { error: 'Pick a country from the list, or leave it empty to clear.' },
          { status: 400 }
        );
      }
      callingCode = country.dial;
      countryIso = country.iso;
    } else if (rawCode) {
      callingCode = normalizeStoredCallingCode(rawCode);
      if (!callingCode) {
        return NextResponse.json(
          { error: 'Use a calling code such as 234, or leave it empty to clear.' },
          { status: 400 }
        );
      }
      const matches = SITE_PHONE_COUNTRIES.filter((country) => country.dial === callingCode);
      countryIso = matches.length === 1 ? matches[0].iso : null;
    }

    const supabase = getSupabase();
    let updatedResult = await supabase
      .from('accounts')
      .update({ default_calling_code: callingCode, default_country_iso: countryIso })
      .eq('id', accountId)
      .select(ACCOUNT_SELECT)
      .single();
    if (updatedResult.error && /default_country_iso/i.test(String(updatedResult.error.message || ''))) {
      updatedResult = await supabase
        .from('accounts')
        .update({ default_calling_code: callingCode })
        .eq('id', accountId)
        .select(ACCOUNT_SELECT_BASE)
        .single();
    }
    const { data: updated, error } = updatedResult;

    if (error) {
      const message = String(error.message || '');
      const code = String(error.code || '');
      if (
        code === '42703' ||
        code === 'PGRST204' ||
        (/default_calling_code/i.test(message) && /column|schema cache/i.test(message))
      ) {
        return NextResponse.json(
          { error: 'Saving a country code is not available yet.' },
          { status: 503 }
        );
      }
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    return NextResponse.json({ account: toPublicAccount(updated) });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
