import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { hashPassword } from '../../../../lib/cryptoPin';
import { createSession } from '../../../../lib/cookies';
import { validatePassword } from '../../../../lib/passwordPolicy';
import { deriveAgentAddress } from '../../../../lib/agentWallet';
import { toPublicAccount } from '../../../../lib/publicAccount';
import { validateUsername } from '../../../../lib/username';
import { normalizeLocale } from '../../../../lib/locale';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/auth/signup';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim() || null;
    const locale = normalizeLocale(body.locale);

    // Required: Flizy @username is the recognition handle after onboarding.
    const check = validateUsername(body.username);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }
    const username = check.username;

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }
    const pw = validatePassword(password);
    if (!pw.ok) {
      return NextResponse.json({ error: pw.error }, { status: 400 });
    }

    const supabase = getSupabase();
    const password_hash = hashPassword(password);
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .from('accounts')
      .insert({
        email,
        password_hash,
        display_name: displayName,
        username,
        username_changed_at: nowIso,
        locale,
        agent_wallet_address: null,
      })
      .select('id, email, display_name, username, username_changed_at, locale, agent_wallet_address')
      .single();

    if (error) {
      if (String(error.message).includes('duplicate') || error.code === '23505') {
        const msg = String(error.message || '').toLowerCase();
        if (msg.includes('username') || msg.includes('accounts_username')) {
          return NextResponse.json({ error: 'That username is taken.' }, { status: 409 });
        }
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
      }
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    const { data: withWallet, error: wErr } = await supabase
      .from('accounts')
      .update({ agent_wallet_address: deriveAgentAddress(data.id) })
      .eq('id', data.id)
      .select(
        'email, display_name, username, username_changed_at, locale, agent_wallet_address, balance_eth'
      )
      .single();
    if (wErr) {
      return NextResponse.json(apiErrorBody(ROUTE, wErr, { accountId: data.id }), { status: 500 });
    }

    await createSession(data.id);
    return NextResponse.json({ account: toPublicAccount(withWallet) });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
