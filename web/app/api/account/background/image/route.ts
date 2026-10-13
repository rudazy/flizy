/**
 * The signed-in account's background file.
 * GET streams it. POST stores a new one. Nobody else's session can read it,
 * because the path is loaded from that session's row only.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBody } from '../../../../../lib/apiError';
import { BACKGROUND_MAX_BYTES, readBackgroundImage, uploadBackground } from '../../../../../lib/accountBackground';

const POST_ROUTE = 'POST /api/account/background/image';
const GET_ROUTE = 'GET /api/account/background/image';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    const result = await readBackgroundImage({ supabase: getSupabase() }, accountId);
    if (result.status !== 200) {
      return NextResponse.json(result.body, { status: result.status });
    }
    const bytes = new Uint8Array(result.bytes);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'private, max-age=86400',
        'Vary': 'Cookie',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(GET_ROUTE, err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (file instanceof File && file.size > BACKGROUND_MAX_BYTES) {
      return NextResponse.json({ error: 'That image is too large.' }, { status: 400 });
    }
    const bytes = file instanceof File ? new Uint8Array(await file.arrayBuffer()) : null;
    const dim = form?.get('dim');
    const result = await uploadBackground(
      { supabase: getSupabase() },
      accountId,
      bytes,
      typeof dim === 'string' ? dim : undefined
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (err) {
    return NextResponse.json(apiErrorBody(POST_ROUTE, err), { status: 500 });
  }
}
