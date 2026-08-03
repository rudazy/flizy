import { NextResponse } from 'next/server';
import { getAccountIdFromCookie, getSessionKey } from '../../../../../lib/cookies';
import { createOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { apiErrorBody } from '../../../../../lib/apiError';
import { discordAuthorizeUrl, discordOAuthConfigured } from '../../../../../lib/discordOAuth';

const ROUTE = 'GET /api/auth/discord/start';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    const sessionKey = getSessionKey();
    if (!accountId || !sessionKey) {
      return NextResponse.json({ error: 'Log in first' }, { status: 401 });
    }

    if (!discordOAuthConfigured() || !oauthStateConfigured()) {
      console.error(`[oauth] ${ROUTE}: Discord OAuth env is incomplete`);
      return NextResponse.json({ error: 'Discord linking is not available' }, { status: 503 });
    }

    const state = createOAuthState(sessionKey);
    return NextResponse.redirect(discordAuthorizeUrl(state));
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
