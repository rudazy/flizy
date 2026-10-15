/**
 * The PIN step for chat: GET shows what a link would approve, POST approves it.
 *
 * Chat never takes the PIN. When it needs one (unlock, a payment that needs
 * it, unlink), the bot writes a chat_approvals row and sends a link to
 * /a/<token> (lib/chatApprovals.js). This route is what that page talks to.
 *
 * - No session cookie: chat users often never sign in on their phone browser.
 *   The token (128 bits, stored only as its hash, 5 minutes, single use) and
 *   the PIN together are the proof.
 * - GET changes nothing, so a link preview or a crawler opening the link is
 *   harmless. It answers only for a link that is still open.
 * - POST checks the PIN on the account-wide PIN counter (web/lib/pinGate.ts).
 *   A pause burns the link: the request it carried is cancelled and the bot
 *   says so in the chat.
 * - Approval is a compare-and-swap on a row that is still open and in date,
 *   so two submits cannot both approve.
 * - The response never names the account, only the chat label the bot wrote.
 */

import { createHash } from 'crypto';
import { NextResponse } from 'next/server';

import { apiErrorBody } from '@/lib/apiError';
import { checkPin } from '@/lib/pinGate';
import { rejectIfCrossOrigin } from '@/lib/requestOrigin.ts';
import { getSupabase } from '@/lib/supabase.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = 'approvals/[token]';
const NO_STORE = { 'cache-control': 'no-store' };
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

type Row = {
  id: string;
  account_id: string;
  kind: string;
  summary: { title?: string; lines?: string[] } | null;
  chat_label: string | null;
  expires_at: string;
  approved_at: string | null;
  consumed_at: string | null;
  cancelled_at: string | null;
};

type Status = 'open' | 'expired' | 'used' | 'replaced' | 'missing';

function statusOf(row: Row | null): Status {
  if (!row) return 'missing';
  if (row.cancelled_at) return 'replaced';
  if (row.approved_at || row.consumed_at) return 'used';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'open';
}

async function readRow(token: string): Promise<Row | null> {
  if (!TOKEN.test(token)) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const { data, error } = await getSupabase()
    .from('chat_approvals')
    .select('id, account_id, kind, summary, chat_label, expires_at, approved_at, consumed_at, cancelled_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Row | null) || null;
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  try {
    const row = await readRow(String(params.token || ''));
    const status = statusOf(row);
    if (status !== 'open' || !row) {
      return NextResponse.json({ status }, { headers: NO_STORE });
    }
    return NextResponse.json(
      {
        status,
        kind: row.kind,
        title: String(row.summary?.title || ''),
        lines: (row.summary?.lines || []).map((l) => String(l)).slice(0, 12),
        chatLabel: row.chat_label || '',
        expiresAt: row.expires_at,
      },
      { headers: NO_STORE }
    );
  } catch (err) {
    return NextResponse.json(apiErrorBody(`GET ${ROUTE}`, err), { status: 500, headers: NO_STORE });
  }
}

export async function POST(req: Request, { params }: { params: { token: string } }) {
  const denied = rejectIfCrossOrigin(req);
  if (denied) return denied;
  try {
    const row = await readRow(String(params.token || ''));
    const status = statusOf(row);
    if (status !== 'open' || !row) {
      return NextResponse.json({ status }, { status: 409, headers: NO_STORE });
    }

    const body = await req.json().catch(() => ({}));
    const pin = String(body?.pin || '');
    const supabase = getSupabase();
    const check = await checkPin(supabase, row.account_id, pin);
    if (!check.ok) {
      if (check.reason === 'locked') {
        await supabase
          .from('chat_approvals')
          .update({ cancelled_at: new Date().toISOString() })
          .eq('id', row.id)
          .is('approved_at', null)
          .is('cancelled_at', null);
        return NextResponse.json({ status: 'locked', error: check.error }, { status: 429, headers: NO_STORE });
      }
      return NextResponse.json(
        { status: 'open', error: check.error, ...(check.reason === 'wrong' ? { attemptsLeft: check.attemptsLeft } : {}) },
        { status: check.status, headers: NO_STORE }
      );
    }

    const { data: approved, error } = await supabase
      .from('chat_approvals')
      .update({ approved_at: new Date().toISOString() })
      .eq('id', row.id)
      .is('approved_at', null)
      .is('consumed_at', null)
      .is('cancelled_at', null)
      .gt('expires_at', new Date().toISOString())
      .select('id');
    if (error) throw new Error(error.message);
    if (!approved || approved.length === 0) {
      return NextResponse.json({ status: statusOf(await readRow(String(params.token || ''))) }, { status: 409, headers: NO_STORE });
    }
    return NextResponse.json({ status: 'approved', chatLabel: row.chat_label || '' }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(apiErrorBody(`POST ${ROUTE}`, err), { status: 500, headers: NO_STORE });
  }
}
