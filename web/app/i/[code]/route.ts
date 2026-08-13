import { NextResponse } from 'next/server';
import { getSupabase } from '../../../lib/supabase';
import { isInviteCodeFormat, normalizeInviteCode } from '../../../lib/invite.ts';
import { attachInviteCookie } from '../../../lib/inviteCookie.ts';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: { code: string } }
) {
  const code = normalizeInviteCode(params?.code);
  if (!isInviteCodeFormat(code)) {
    return new NextResponse('Invite not found.', { status: 404 });
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('invite_codes')
    .select('code')
    .eq('code', code)
    .maybeSingle();

  if (error || !data?.code) {
    return new NextResponse('Invite not found.', { status: 404 });
  }

  const res = NextResponse.redirect(new URL('/signup', _req.url), 302);
  attachInviteCookie(res, data.code);
  return res;
}
