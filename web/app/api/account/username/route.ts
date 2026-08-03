/**
 * Set or change the Flizy-native @username for the signed-in account.
 *
 * Required at signup. Change at most once every 30 days.
 * Not a payment routing key — platform ids and phones still are.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { toPublicAccount } from '../../../../lib/publicAccount';
import {
  assertUsernameChangeAllowed,
  validateUsername,
} from '../../../../lib/username';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/account/username';

const ACCOUNT_SELECT =
  'email, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth, unlock_pin_hash, daily_send_limit_eth';

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

    const { data: current } = await supabase
      .from('accounts')
      .select(`id, ${ACCOUNT_SELECT}`)
      .eq('id', accountId)
      .maybeSingle();

    if (!current) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    const gate = assertUsernameChangeAllowed({
      currentUsername: current.username,
      usernameChangedAt: current.username_changed_at,
      nextUsername: check.username,
    });
    if (!gate.ok) {
      return NextResponse.json(
        { error: gate.error, username_next_change_at: gate.nextChangeAt },
        { status: 429 }
      );
    }
    if (gate.isNoop) {
      return NextResponse.json({ account: toPublicAccount(current) });
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from('accounts')
      .update({ username: check.username, username_changed_at: nowIso })
      .eq('id', accountId)
      .select(ACCOUNT_SELECT)
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
