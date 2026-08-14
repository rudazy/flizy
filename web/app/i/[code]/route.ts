import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabase';
import { resolveInviterByRef } from '../../../lib/invite.ts';
import { attachInviteCookie } from '../../../lib/inviteCookie.ts';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { code: string } }
) {
  const supabase = getSupabase();
  let owned = null;
  try {
    owned = await resolveInviterByRef(supabase, params?.code);
  } catch {
    owned = null;
  }
  if (!owned?.code) {
    return new NextResponse('Invite not found.', { status: 404 });
  }

  const res = NextResponse.redirect(new URL('/signup', _req.url), 302);
  attachInviteCookie(res, owned.code);
  return res;
}
