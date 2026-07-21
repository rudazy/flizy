import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { hashPassword } from '../../../../lib/cryptoPin';
import { setAccountCookie } from '../../../../lib/cookies';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');
    const displayName = String(body.displayName || '').trim() || null;

    if (!email || password.length < 8) {
      return NextResponse.json({ error: 'Email and password (8+ chars) required' }, { status: 400 });
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
      if (String(error.message).includes('duplicate') || error.code === '23505') {
        return NextResponse.json({ error: 'Email already registered' }, { status: 409 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Same derivation as bot lib/agentWallet.js (keccak256 + ethers.Wallet)
    const { Wallet, keccak256, toUtf8Bytes } = await import('ethers');
    const material = keccak256(toUtf8Bytes(`flizy:agent:v1:${data.id}`));
    const w = new Wallet(material);
    const { data: withWallet, error: wErr } = await supabase
      .from('accounts')
      .update({ agent_wallet_address: w.address })
      .eq('id', data.id)
      .select('id, email, display_name, agent_wallet_address, balance_eth')
      .single();
    if (wErr) {
      return NextResponse.json({ error: wErr.message }, { status: 500 });
    }

    setAccountCookie(withWallet.id);
    return NextResponse.json({ account: withWallet });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Signup failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
