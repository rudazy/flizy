import { NextResponse } from 'next/server';
import { getSupabase } from '../../../../lib/supabase';
import { verifyPassword } from '../../../../lib/cryptoPin';
import { setAccountCookie } from '../../../../lib/cookies';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('accounts')
      .select('id, email, password_hash, display_name')
      .eq('email', email)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data?.password_hash || !verifyPassword(password, data.password_hash)) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
    }

    setAccountCookie(data.id);
    return NextResponse.json({
      account: { id: data.id, email: data.email, display_name: data.display_name },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Login failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
