import { NextResponse } from 'next/server';
import { createLinkCode } from '../../../../lib/identity';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { linkCodeMail, mailOwner } from '../../../../lib/securityNotice.ts';
import { siteOrigin } from '../../../../lib/siteOrigin';

const ROUTE = 'POST /api/link/create';

/**
 * Mint a chat link code.
 *
 * A link code hands a chat app control of the account, so it takes the account
 * password like every other authority change: a stolen session cookie alone
 * must not be able to attach the thief's own chat. The owner is emailed each
 * time, because chat warnings only reach chats that are already linked.
 *
 * The code is returned here and nowhere else (GET /api/dashboard no longer
 * carries it), so it exists only in the browser that proved the password.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as { password?: unknown } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (password.length > 256) return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });

    const supabase = getSupabase();
    const auth = await requirePassword(supabase, accountId, password, 'link a chat app');
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }

    const link = await createLinkCode(accountId);
    await mailOwner(supabase, accountId, linkCodeMail(siteOrigin(), new Date()));
    return NextResponse.json(link);
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
