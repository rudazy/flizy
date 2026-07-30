import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabase';
import { hashPin } from '../../../lib/cryptoPin';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { clearChatPinLockout, requirePassword } from '../../../lib/passwordGate';

/**
 * Set or replace the chat unlock PIN.
 *
 * The session cookie alone used to be enough here, which made this the softest
 * way into the money: the PIN is what unlocks sends in chat, so an open browser
 * tab could reassign it without proving anything. It now takes the same
 * password re-auth as the trusted list and the daily limit.
 *
 * It is also the recovery path for the failed-PIN lockout in lib/session.js.
 * See clearChatPinLockout for why the two belong together.
 */
export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json();
    const pin = String(body.pin || '');
    if (!/^\d{4,12}$/.test(pin)) {
      return NextResponse.json({ error: 'PIN must be 4-12 digits' }, { status: 400 });
    }

    const supabase = getSupabase();
    const auth = await requirePassword(
      supabase,
      accountId,
      String(body.password || ''),
      'change your unlock PIN'
    );
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const unlock_pin_hash = hashPin(pin);
    const { error } = await supabase
      .from('accounts')
      .update({ unlock_pin_hash })
      .eq('id', accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const lockoutCleared = await clearChatPinLockout(supabase, accountId);
    return NextResponse.json({ ok: true, lockout_cleared: lockoutCleared });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'PIN update failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
