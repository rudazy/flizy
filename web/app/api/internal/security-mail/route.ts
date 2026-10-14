/**
 * Email the account owner about a chat that was just linked or unlinked.
 *
 * Called by the bots, which hold no mail credentials. The bot sends only the
 * account id and which kind of event happened. The site then looks for that
 * event in identity_events within the last few minutes and mails only what it
 * finds there, to the email on the account. So the shared secret lets a caller
 * ask for a notice, but not choose who receives it, what it says, or describe
 * an event that did not happen.
 *
 * Server to server: there is no cookie and no browser, so the Origin check the
 * other mutating routes run does not apply. SECURITY_MAIL_SECRET unset refuses
 * every caller. The response says only whether a mail was sent.
 */

import { NextResponse } from 'next/server';

import { apiErrorBody } from '@/lib/apiError';
import { bearerMatches } from '@/lib/bearerSecret';
import { getSupabase } from '@/lib/supabase.ts';
import { siteOrigin } from '@/lib/siteOrigin';
import {
  chatChangeMail,
  listLinkedChats,
  mailOwner,
  recentChatEvent,
  type ChatEvent,
} from '@/lib/securityNotice';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = 'POST /api/internal/security-mail';

const NO_STORE = { 'cache-control': 'no-store' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KINDS: ReadonlyArray<ChatEvent['kind']> = ['linked', 'unlinked'];

export async function POST(req: Request) {
  if (!bearerMatches(req.headers.get('authorization'), process.env.SECURITY_MAIL_SECRET)) {
    return NextResponse.json({ ok: false }, { status: 401, headers: NO_STORE });
  }

  const body = await req.json().catch(() => null);
  const accountId = typeof body?.accountId === 'string' ? body.accountId : '';
  const kind = KINDS.find((k) => k === body?.kind);
  if (!UUID.test(accountId) || !kind) {
    return NextResponse.json({ ok: false }, { status: 400, headers: NO_STORE });
  }

  try {
    const supabase = getSupabase();
    const event = await recentChatEvent(supabase, accountId, kind);
    if (!event) {
      return NextResponse.json({ ok: false }, { status: 404, headers: NO_STORE });
    }
    const chats = await listLinkedChats(supabase, accountId);
    const sent = await mailOwner(supabase, accountId, chatChangeMail(siteOrigin(), event, chats));
    return NextResponse.json({ ok: sent }, { status: sent ? 200 : 502, headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500, headers: NO_STORE });
  }
}
