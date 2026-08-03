/**
 * Set or change the Flizy-native @username for the signed-in account.
 *
 * Optional at signup; editable here with uniqueness enforced by DB index.
 * Not a payment routing key — platform ids and phones still are.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { toPublicAccount } from '../../../../lib/publicAccount';
import { validateUsername } from '../../../../lib/username';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/account/username';

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const check = validateUsername(body.username);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }

    const supabase = getSupabase();

    // Same account already holds this name: idempotent success.
    const { data: current } = await supabase
      .from('accounts')
      .select('id, email, display_name, username, agent_wallet_address, balance_eth, unlock_pin_hash, daily_send_limit_eth')
      .eq('id', accountId)
      .maybeSingle();

    if (!current) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const existing = current.username
      ? String(current.username).trim().toLowerCase()
      : '';
    if (existing === check.username) {
      return NextResponse.json({ account: toPublicAccount(current) });
    }

    const { data: updated, error } = await supabase
      .from('accounts')
      .update({ username: check.username })
      .eq('id', accountId)
      .select(
        'email, display_name, username, agent_wallet_address, balance_eth, unlock_pin_hash, daily_send_limit_eth'
      )
      .single();

    if (error) {
      if (error.code === '23505' || String(error.message).toLowerCase().includes('duplicate')) {
        return NextResponse.json({ error: 'That username is taken.' }, { status: 409 });
      }
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    return NextResponse.json({ account: toPublicAccount(updated) });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
