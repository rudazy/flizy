/**
 * Linked identities for the Account tab.
 *
 * GET    platforms + chat apps (no raw external ids for platforms)
 * DELETE unlink one channel, behind a password re-entry
 *
 * Platforms: github / discord / x
 * Chat: whatsapp / telegram (unlinking drops phone_e164 on that row — phone claims
 * can no longer match via that channel until re-linked)
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { requirePassword } from '../../../lib/passwordGate.ts';
import { displaySafeLabel } from '../../../lib/sanitize.ts';
import { unlinkChannelIdentity, BindError } from '../../../lib/channelBind.ts';
import { apiErrorBody } from '../../../lib/apiError';

const ROUTE_GET = 'GET /api/identity';
const ROUTE_DELETE = 'DELETE /api/identity';

const PLATFORMS = ['github', 'discord', 'x'] as const;
const CHAT = ['whatsapp', 'telegram'] as const;
const ALL = [...PLATFORMS, ...CHAT] as const;

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('channel_identities')
      .select('channel, external_id, display_handle, phone_e164, linked_at')
      .eq('account_id', accountId)
      .in('channel', ALL as unknown as string[]);

    if (error) throw new Error(error.message);

    // Owner-only session: full phone is fine here (public claim links stay masked).
    const identities = (data || []).map((row) => {
      const ch = String(row.channel);
      const isChat = ch === 'whatsapp' || ch === 'telegram';
      const phone = row.phone_e164 ? String(row.phone_e164).replace(/\D/g, '') : '';
      return {
        channel: ch,
        // Platforms: handle only. Chat: full proven number for the account owner.
        handle: isChat ? null : displaySafeLabel(row.display_handle) || null,
        phone: isChat && phone ? `+${phone}` : null,
        has_phone: Boolean(phone),
        linked_at: row.linked_at || null,
      };
    });

    return NextResponse.json({ identities });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE_GET, err), { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const channel = String(body.channel || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');

    if (!(ALL as readonly string[]).includes(channel)) {
      return NextResponse.json({ error: 'Unsupported channel' }, { status: 400 });
    }

    const supabase = getSupabase();
    const auth = await requirePassword(supabase, accountId, password, 'unlink an account');
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const res = await unlinkChannelIdentity(supabase, { accountId, channel });
    return NextResponse.json({
      ok: true,
      removed: res.removed,
      channel,
    });
  } catch (err) {
    if (err instanceof BindError) {
      return NextResponse.json({ error: err.message || 'Could not unlink' }, { status: 400 });
    }
    return NextResponse.json(apiErrorBody(ROUTE_DELETE, err), { status: 500 });
  }
}
