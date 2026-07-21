import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabase';
import { hashPin } from '../../../lib/cryptoPin';
import { getAccountIdFromCookie } from '../../../lib/cookies';

export async function POST(req: Request) {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json();
    const pin = String(body.pin || '');
    if (!/^\d{4,12}$/.test(pin)) {
      return NextResponse.json({ error: 'PIN must be 4-12 digits' }, { status: 400 });
    }
    const supabase = getSupabase();
    const unlock_pin_hash = hashPin(pin);
    const { error } = await supabase
      .from('accounts')
      .update({ unlock_pin_hash })
      .eq('id', accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PIN update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
