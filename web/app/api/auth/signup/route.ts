import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { hashPassword } from '../../../../lib/cryptoPin';
import { createSession } from '../../../../lib/cookies';
import { validatePassword } from '../../../../lib/passwordPolicy';
import { deriveAgentAddress } from '../../../../lib/agentWallet';
import { toPublicAccount } from '../../../../lib/publicAccount';
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

    if (!email) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }
    const pw = validatePassword(password);
    if (!pw.ok) {
      return NextResponse.json({ error: pw.error }, { status: 400 });
    }

    const supabase = getSupabase();
    const password_hash = hashPassword(password);
    const { data, error } = await supabase
      .from('accounts')
      .insert({
        email,
        password_hash,
        display_name: displayName,
        agent_wallet_address: null,
      })
      .select('id, email, display_name, agent_wallet_address')
      .single();

    if (error) {
      // Reading the constraint is ours to do; the client gets the sentence we
      // wrote for it, not the constraint name.
      if (String(error.message).includes('duplicate') || error.code === '23505') {
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
      }
      // No email in the log line: an identifier that is also PII is not worth it
      // when the error itself already says which constraint or column failed.
      return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    }

    // Same derivation as bot lib/agentWallet.js, via the shared web module
    const { data: withWallet, error: wErr } = await supabase
      .from('accounts')
      .update({ agent_wallet_address: deriveAgentAddress(data.id) })
      .eq('id', data.id)
      .select('email, display_name, agent_wallet_address, balance_eth')
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
