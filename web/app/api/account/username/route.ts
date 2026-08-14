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
  isUsernameReserved,
  USERNAME_UNAVAILABLE,
  validateUsername,
} from '../../../../lib/username';
import { apiErrorBody } from '../../../../lib/apiError';
import { ensureInviteCode } from '../../../../lib/invite.ts';

const ROUTE = 'POST /api/account/username';

const ACCOUNT_SELECT =
  'email, email_verified_at, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth, unlock_pin_hash, daily_send_limit_eth';

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
    // Holders of a name that later becomes reserved may keep it (noop).
    if (gate.isNoop) {
      return NextResponse.json({ account: toPublicAccount(current) });
    }

    if (await isUsernameReserved(supabase, check.username)) {
      return NextResponse.json({ error: USERNAME_UNAVAILABLE }, { status: 409 });
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error } = await supabase
      .from('accounts')
      .update({ username: check.username, username_changed_at: nowIso })
      .eq('id', accountId)
      .select(ACCOUNT_SELECT)
      .single();

    if (error) {
      // Unique index, or FZ002 reserved trigger.
      const code = String(error.code || '');
      const msg = String(error.message || '').toLowerCase();
      if (
        code === '23505' ||
        code === 'FZ002' ||
        msg.includes('duplicate') ||
        msg.includes('username is reserved')
      ) {
        return NextResponse.json({ error: USERNAME_UNAVAILABLE }, { status: 409 });
      }
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    try {
      await ensureInviteCode(supabase, accountId);
    } catch (err) {
      console.warn('[username] invite ref:', err instanceof Error ? err.message : err);
    }

    return NextResponse.json({ account: toPublicAccount(updated) });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
