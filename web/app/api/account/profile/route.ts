/**
 * Complete onboarding profile: required @username + optional display name.
 * Used after email verification, before dashboard features unlock.
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

const ROUTE = 'POST /api/account/profile';

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

    const displayNameRaw = String(body.displayName ?? body.display_name ?? '').trim();
    const display_name = displayNameRaw ? displayNameRaw.slice(0, 64) : null;

    const supabase = getSupabase();
    const { data: current } = await supabase
      .from('accounts')
      .select(`id, ${ACCOUNT_SELECT}`)
      .eq('id', accountId)
      .maybeSingle();

    if (!current) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    if (!current.email_verified_at) {
      return NextResponse.json(
        { error: 'Verify your email before setting a username.' },
        { status: 403 }
      );
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

    const nowIso = new Date().toISOString();
    const patch: Record<string, string | null> = {
      display_name,
    };
    // Holders of a name that later becomes reserved may keep it (noop).
    if (!gate.isNoop) {
      if (await isUsernameReserved(supabase, check.username)) {
        return NextResponse.json({ error: USERNAME_UNAVAILABLE }, { status: 409 });
      }
      patch.username = check.username;
      patch.username_changed_at = nowIso;
    }

    const { data: updated, error } = await supabase
      .from('accounts')
      .update(patch)
      .eq('id', accountId)
      .select(ACCOUNT_SELECT)
      .single();

    if (error) {
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

    return NextResponse.json({ account: toPublicAccount(updated) });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
