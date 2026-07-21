import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';

export async function GET() {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const supabase = getSupabase();

    // Prefer account_id; fall back to phones linked to this account
    const { data: identities } = await supabase
      .from('whatsapp_identities')
      .select('wa_sender_id')
      .eq('account_id', accountId);

    const phones = (identities || []).map((i) => i.wa_sender_id).filter(Boolean);

    let query = supabase
      .from('transfers')
      .select('id, amount_eth, to_address, status, tx_hash, created_at, phone, chain_id')
      .order('created_at', { ascending: false })
      .limit(10);

    if (phones.length > 0) {
      query = query.or(`account_id.eq.${accountId},phone.in.(${phones.join(',')})`);
    } else {
      query = query.eq('account_id', accountId);
    }

    const { data, error } = await query;
    if (error) {
      // Fallback: account_id only (or empty)
      const { data: byAccount, error: e2 } = await supabase
        .from('transfers')
        .select('id, amount_eth, to_address, status, tx_hash, created_at, phone, chain_id')
        .eq('account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(10);
      if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });
      return NextResponse.json({ transfers: byAccount || [] });
    }

    return NextResponse.json({ transfers: data || [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'History failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
