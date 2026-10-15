import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getSupabase } from '../../../lib/supabase';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { requirePassword } from '../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../lib/apiError';
import { ethToWei, quickSendCeilingWei, readQuickSend } from '../../../lib/tiers.ts';

const ROUTE = 'POST /api/limits';

/** The account's own quick-send setting, for the money screens. */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    return NextResponse.json({ quickSend: await readQuickSend(getSupabase(), accountId) });
  } catch (err) {
    return NextResponse.json(apiErrorBody('GET /api/limits', err), { status: 500 });
  }
}

/**
 * Change the daily send limit, the quick-send amount, or both. Each is changed
 * only when its key is in the body; null (or empty) returns it to the app
 * default. Both take the account password.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
    }
    const update: { daily_send_limit_eth?: number | null; quick_send_eth?: string | null } = {};

    if ('daily_send_limit_eth' in body) {
      const raw = body.daily_send_limit_eth;
      if (raw === null || raw === '' || raw === undefined) {
        update.daily_send_limit_eth = null;
      } else {
        const daily = Number(raw);
        if (!Number.isFinite(daily) || daily < 0) {
          return NextResponse.json(
            { error: 'Limit must be a number >= 0, or empty to clear (app default)' },
            { status: 400 }
          );
        }
        if (daily > 1000) {
          return NextResponse.json({ error: 'Limit too large' }, { status: 400 });
        }
        update.daily_send_limit_eth = daily;
      }
    }

    if ('quick_send_eth' in body) {
      const raw = body.quick_send_eth;
      if (raw === null || raw === '' || raw === undefined) {
        update.quick_send_eth = null;
      } else {
        const wei = ethToWei(typeof raw === 'number' || typeof raw === 'string' ? raw : null);
        if (wei == null) {
          return NextResponse.json(
            { error: 'Quick send must be a number >= 0, or empty for the app default' },
            { status: 400 }
          );
        }
        // Raising it past the default comes with a waiting period, not built yet.
        if (wei > quickSendCeilingWei()) {
          return NextResponse.json({ error: 'Quick send cannot be above the app default yet.' }, { status: 400 });
        }
        update.quick_send_eth = ethers.formatEther(wei);
      }
    }

    if (!Object.keys(update).length) {
      return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
    }

    const supabase = getSupabase();
    const auth = await requirePassword(
      supabase,
      accountId,
      String(body.password || ''),
      'change your limits'
    );
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }

    const { error } = await supabase.from('accounts').update(update).eq('id', accountId);
    if (error) {
      return NextResponse.json(apiErrorBody(ROUTE, error, { accountId }), { status: 500 });
    }

    return NextResponse.json({ ok: true, ...update });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
