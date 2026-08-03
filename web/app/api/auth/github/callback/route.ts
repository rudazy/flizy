/**
 * Finish the GitHub OAuth round trip and bind the identity.
 *
 * Order matters here and mirrors the bind core's own discipline:
 *   1. rate limit, before any work
 *   2. session, so we know who is asking
 *   3. state, so we know we started this
 *   4. exchange, so GitHub proves the identity
 *   5. bind, which carries the four protections
 *
 * The externalId handed to the bind is always the numeric id GitHub returned.
 * Nothing here accepts a caller-supplied identity, which is the invariant that
 * makes enumeration impossible.
 *
 * Failures redirect back to the Account tab with a short code rather than
 * rendering JSON, because a human is sitting in a browser at this point.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie, getSessionKey } from '../../../../../lib/cookies';
import { verifyOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { logApiError } from '../../../../../lib/apiError';
import { exchangeCodeForIdentity, githubOAuthConfigured } from '../../../../../lib/githubOAuth';
import {
  callbackLimitState,
  recordCallbackFailure,
  clearCallbackFailures,
} from '../../../../../lib/callbackLimiter';
import { bindChannelIdentity, REBIND_POLICY, BindError } from '../../../../../lib/channelBind.ts';
import { getSupabase } from '../../../../../lib/supabase';

const ROUTE = 'GET /api/auth/github/callback';

/**
 * Success lands on Home so pending claims after bind are visible immediately.
 * Failures go to Account (platforms section) where the user started Link GitHub.
 */
function postOAuthUrl(status: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  if (status === 'linked') {
    return `${base}/dashboard?github=linked`;
  }
  return `${base}/dashboard/account?github=${encodeURIComponent(status)}`;
}

export async function GET(req: Request) {
  try {
    // Inside the try on purpose: reading cookies is what makes this route
    // dynamic, and Next signals that by throwing. Outside, that throw would
    // escape unhandled instead of reaching the rethrow in logApiError.
    const sessionKey = getSessionKey();

    // 1. Refuse early if this session has been failing repeatedly. Before the
    //    session lookup, the state check and any call out to GitHub.
    if (sessionKey) {
      const limit = await callbackLimitState(sessionKey);
      if (limit.locked) {
        return NextResponse.redirect(postOAuthUrl('rate_limited'));
      }
    }

    if (!githubOAuthConfigured() || !oauthStateConfigured()) {
      // A misconfiguration, not a user error. Which variable is missing stays
      // in the server log.
      logApiError(ROUTE, new Error('GitHub OAuth env is incomplete'));
      return NextResponse.redirect(postOAuthUrl('unavailable'));
    }

    // 2. Who is asking.
    const accountId = await getAccountIdFromCookie();
    if (!accountId || !sessionKey) {
      return NextResponse.redirect(postOAuthUrl('login_required'));
    }

    const url = new URL(req.url);
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';

    // The user pressed cancel on GitHub's consent screen. Not a failure worth
    // counting against them.
    if (url.searchParams.get('error')) {
      return NextResponse.redirect(postOAuthUrl('cancelled'));
    }

    // 3. Did we start this, from this session, recently.
    const stateCheck = verifyOAuthState(state, sessionKey);
    if (!stateCheck.ok) {
      console.warn(`[oauth] state rejected: ${stateCheck.reason}`);
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl('state_invalid'));
    }

    if (!code) {
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl('state_invalid'));
    }

    // 4. GitHub proves the identity. The token is used once and discarded.
    const identity = await exchangeCodeForIdentity(code);
    if (!identity) {
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl('exchange_failed'));
    }

    // 5. Bind. Policy is reject: an identity already on another account is not
    //    moved, because OAuth is not proof of intent for the OLD account, and a
    //    silent move would redirect that handle's payouts without its owner's
    //    password.
    try {
      await bindChannelIdentity(getSupabase(), {
        accountId,
        channel: 'github',
        externalId: identity.externalId,
        displayHandle: identity.login,
        rebindPolicy: REBIND_POLICY.REJECT,
      });
    } catch (err) {
      if (err instanceof BindError) {
        if (err.code === 'IDENTITY_TAKEN') return NextResponse.redirect(postOAuthUrl('identity_taken'));
        if (err.code === 'ALREADY_LINKED_DIFFERENT') {
          return NextResponse.redirect(postOAuthUrl('already_linked'));
        }
        if (err.code === 'LOCKED') return NextResponse.redirect(postOAuthUrl('rate_limited'));
      }
      throw err;
    }

    await clearCallbackFailures(sessionKey);
    return NextResponse.redirect(postOAuthUrl('linked'));
  } catch (err) {
    // Routes the failure through the same helper every other route uses, which
    // redacts secret-shaped substrings before they reach the log and rethrows
    // Next's dynamic-usage signal rather than swallowing it as a fake 500.
    logApiError(ROUTE, err);
    return NextResponse.redirect(postOAuthUrl('error'));
  }
}
