import { NextResponse } from 'next/server';
import { getAccountIdFromCookie, getSessionKey } from '../../../../../lib/cookies';
import { verifyOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { logApiError } from '../../../../../lib/apiError';
import {
  exchangeCodeForIdentity,
  takePkceVerifier,
  xOAuthConfigured,
} from '../../../../../lib/xOAuth';
import {
  callbackLimitState,
  recordCallbackFailure,
  clearCallbackFailures,
} from '../../../../../lib/callbackLimiter';
import { bindChannelIdentity, REBIND_POLICY, BindError } from '../../../../../lib/channelBind.ts';
import { getSupabase } from '../../../../../lib/supabase';

const ROUTE = 'GET /api/auth/x/callback';

function postOAuthUrl(status: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  if (status === 'linked') {
    return `${base}/dashboard?x=linked`;
  }
  return `${base}/dashboard/account?s=platforms&x=${encodeURIComponent(status)}`;
}

export async function GET(req: Request) {
  try {
    const sessionKey = await getSessionKey();

    if (sessionKey) {
      const limit = await callbackLimitState(sessionKey);
      if (limit.locked) {
        return NextResponse.redirect(postOAuthUrl('rate_limited'));
      }
    }

    if (!xOAuthConfigured() || !oauthStateConfigured()) {
      logApiError(ROUTE, new Error('X OAuth env is incomplete'));
      return NextResponse.redirect(postOAuthUrl('unavailable'));
    }

    const accountId = await getAccountIdFromCookie();
    if (!accountId || !sessionKey) {
      return NextResponse.redirect(postOAuthUrl('login_required'));
    }

    const url = new URL(req.url);
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';

    if (url.searchParams.get('error')) {
      return NextResponse.redirect(postOAuthUrl('cancelled'));
    }

    const stateCheck = verifyOAuthState(state, sessionKey);
    if (!stateCheck.ok) {
      console.warn(`[oauth:x] state rejected: ${stateCheck.reason}`);
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl('state_invalid'));
    }

    const codeVerifier = await takePkceVerifier();
    if (!code || !codeVerifier) {
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl('state_invalid'));
    }

    const exchanged = await exchangeCodeForIdentity(code, codeVerifier);
    if (!exchanged.ok) {
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl(exchanged.reason));
    }
    const identity = exchanged.identity;

    try {
      await bindChannelIdentity(getSupabase(), {
        accountId,
        channel: 'x',
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
    logApiError(ROUTE, err);
    return NextResponse.redirect(postOAuthUrl('error'));
  }
}
