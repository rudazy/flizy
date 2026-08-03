import { NextResponse } from 'next/server';
import { getAccountIdFromCookie, getSessionKey } from '../../../../../lib/cookies';
import { verifyOAuthState, oauthStateConfigured } from '../../../../../lib/oauthState';
import { logApiError } from '../../../../../lib/apiError';
import { exchangeCodeForIdentity, discordOAuthConfigured } from '../../../../../lib/discordOAuth';
import {
  callbackLimitState,
  recordCallbackFailure,
  clearCallbackFailures,
} from '../../../../../lib/callbackLimiter';
import { bindChannelIdentity, REBIND_POLICY, BindError } from '../../../../../lib/channelBind.ts';
import { getSupabase } from '../../../../../lib/supabase';

const ROUTE = 'GET /api/auth/discord/callback';

function postOAuthUrl(status: string): string {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, '');
  if (status === 'linked') {
    return `${base}/dashboard?discord=linked`;
  }
  return `${base}/dashboard/account?s=platforms&discord=${encodeURIComponent(status)}`;
}

export async function GET(req: Request) {
  try {
    const sessionKey = getSessionKey();

    if (sessionKey) {
      const limit = await callbackLimitState(sessionKey);
      if (limit.locked) {
        return NextResponse.redirect(postOAuthUrl('rate_limited'));
      }
    }

    if (!discordOAuthConfigured() || !oauthStateConfigured()) {
      logApiError(ROUTE, new Error('Discord OAuth env is incomplete'));
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
      console.warn(`[oauth:discord] state rejected: ${stateCheck.reason}`);
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl('state_invalid'));
    }

    if (!code) {
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl('state_invalid'));
    }

    const identity = await exchangeCodeForIdentity(code);
    if (!identity) {
      await recordCallbackFailure(sessionKey);
      return NextResponse.redirect(postOAuthUrl('exchange_failed'));
    }

    try {
      await bindChannelIdentity(getSupabase(), {
        accountId,
        channel: 'discord',
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
