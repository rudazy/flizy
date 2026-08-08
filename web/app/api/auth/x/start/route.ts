import { NextResponse } from 'next/server';
import { getAccountIdFromCookie, getSessionKey } from '../../../../../lib/cookies';
import { createOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { apiErrorBody } from '../../../../../lib/apiError';
import {
  attachPkceCookie,
  mintPkce,
  xAuthorizeUrl,
  xOAuthConfigured,
} from '../../../../../lib/xOAuth';

const ROUTE = 'GET /api/auth/x/start';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    const sessionKey = await getSessionKey();
    if (!accountId || !sessionKey) {
      return NextResponse.json({ error: 'Log in first' }, { status: 401 });
    }

    if (!xOAuthConfigured() || !oauthStateConfigured()) {
      console.error(`[oauth] ${ROUTE}: X OAuth env is incomplete`);
      return NextResponse.json({ error: 'X linking is not available' }, { status: 503 });
    }

    const state = createOAuthState(sessionKey);
    const { verifier, challenge } = mintPkce();
    // Cookie must ride on this redirect response (cookies().set alone is flaky
    // with NextResponse.redirect on some Vercel paths).
    const res = NextResponse.redirect(xAuthorizeUrl(state, challenge));
    attachPkceCookie(res, verifier);
    return res;
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
