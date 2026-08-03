import { NextResponse } from 'next/server';
import { getAccountIdFromCookie, getSessionKey } from '../../../../../lib/cookies';
import { createOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { apiErrorBody } from '../../../../../lib/apiError';
import {
  createPkceAndStore,
  xAuthorizeUrl,
  xOAuthConfigured,
} from '../../../../../lib/xOAuth';

const ROUTE = 'GET /api/auth/x/start';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    const sessionKey = getSessionKey();
    if (!accountId || !sessionKey) {
      return NextResponse.json({ error: 'Log in first' }, { status: 401 });
    }

    if (!xOAuthConfigured() || !oauthStateConfigured()) {
      console.error(`[oauth] ${ROUTE}: X OAuth env is incomplete`);
      return NextResponse.json({ error: 'X linking is not available' }, { status: 503 });
    }

    const state = createOAuthState(sessionKey);
    const pkce = createPkceAndStore();
    return NextResponse.redirect(xAuthorizeUrl(state, pkce.challenge));
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
