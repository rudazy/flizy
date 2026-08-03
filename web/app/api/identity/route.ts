/**
 * Linked platform identities for the Account tab.
 *
 * GET    what this account has linked
 * DELETE unlink one, behind a password re-entry
 *
 * Unlink asks for the password and link does not, on purpose. Linking already
 * proves ownership twice over (a live session plus a completed OAuth round
 * trip). Unlinking changes where future payments can be routed, which is the
 * same class of change as editing the trusted list, so it is held to the same
 * bar. It is also the only way to move an identity between accounts, since the
 * bind refuses to move one silently.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getSupabase } from '../../../lib/supabase';
import { requirePassword } from '../../../lib/passwordGate.ts';
import { displaySafeLabel } from '../../../lib/sanitize.ts';
import { unlinkChannelIdentity, isPlatformChannel, BindError } from '../../../lib/channelBind.ts';
import { apiErrorBody } from '../../../lib/apiError';

const ROUTE_GET = 'GET /api/identity';
const ROUTE_DELETE = 'DELETE /api/identity';

/** Channels the Account tab can show and unlink. */
const SUPPORTED = ['github', 'discord', 'x'] as const;

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('channel_identities')
      .select('channel, external_id, display_handle, linked_at')
      .eq('account_id', accountId)
      .in('channel', SUPPORTED as unknown as string[]);

    if (error) throw new Error(error.message);

    // The numeric id never leaves the server. The page has no use for it, and
    // it is the value everything routes on.
    const identities = (data || []).map((row) => ({
      channel: row.channel,
      handle: displaySafeLabel(row.display_handle) || null,
      linked_at: row.linked_at || null,
    }));

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
    const channel = String(body.channel || '');
    const password = String(body.password || '');

    if (!isPlatformChannel(channel) || !SUPPORTED.includes(channel as (typeof SUPPORTED)[number])) {
      return NextResponse.json({ error: 'Unsupported channel' }, { status: 400 });
    }

    const supabase = getSupabase();
    const auth = await requirePassword(supabase, accountId, password, 'unlink an account');
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const res = await unlinkChannelIdentity(supabase, { accountId, channel });
    return NextResponse.json({ ok: true, removed: res.removed });
  } catch (err) {
    if (err instanceof BindError) {
      return NextResponse.json({ error: 'Unsupported channel' }, { status: 400 });
    }
    return NextResponse.json(apiErrorBody(ROUTE_DELETE, err), { status: 500 });
  }
}
