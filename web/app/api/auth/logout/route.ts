/**
 * End the browser session: delete web_sessions row and clear cookies.
 */

import { NextResponse } from 'next/server';
import { clearAccountCookie } from '../../../../lib/cookies';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/auth/logout';

export async function POST() {
  try {
    await clearAccountCookie();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
