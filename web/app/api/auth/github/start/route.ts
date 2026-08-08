/**
 * Begin the GitHub OAuth round trip.
 *
 * Nothing is bound here. This only mints a session-bound state value and sends
 * the browser to GitHub. The bind happens in the callback, after GitHub has
 * proven which account the caller controls.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie, getSessionKey } from '../../../../../lib/cookies';
import { createOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { apiErrorBody } from '../../../../../lib/apiError';
import { githubAuthorizeUrl, githubOAuthConfigured } from '../../../../../lib/githubOAuth';

const ROUTE = 'GET /api/auth/github/start';

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    const sessionKey = await getSessionKey();
    if (!accountId || !sessionKey) {
      return NextResponse.json({ error: 'Log in first' }, { status: 401 });
    }

    if (!githubOAuthConfigured() || !oauthStateConfigured()) {
      // A misconfiguration, not a user error. The specific missing variable
      // stays in the server log.
      console.error(`[oauth] ${ROUTE}: GitHub OAuth env is incomplete`);
      return NextResponse.json({ error: 'GitHub linking is not available' }, { status: 503 });
    }

    const state = createOAuthState(sessionKey);
    return NextResponse.redirect(githubAuthorizeUrl(state));
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
