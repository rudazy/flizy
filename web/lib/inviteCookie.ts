/**
 * Invite attribution cookie. Split from invite.ts so the gate logic can be
 * imported in tests without loading next/headers.
 */

import type { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  INVITE_COOKIE,
  INVITE_COOKIE_SRC,
  INVITE_COOKIE_MAX_AGE_SEC,
  INVITE_SOURCE,
  isInviteCodeFormat,
  normalizeInviteCode,
  normalizeInviteSource,
} from './invite.ts';

export { INVITE_COOKIE, INVITE_COOKIE_SRC, INVITE_COOKIE_MAX_AGE_SEC };

export function inviteCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

export function attachInviteCookie(
  res: NextResponse,
  code: string,
  source?: string | null
): void {
  const slug = normalizeInviteCode(code);
  if (!isInviteCodeFormat(slug)) return;
  const opts = inviteCookieOptions(INVITE_COOKIE_MAX_AGE_SEC);
  res.cookies.set(INVITE_COOKIE, slug, opts);
  res.cookies.set(INVITE_COOKIE_SRC, normalizeInviteSource(source), opts);
}

export function readInviteCookie(): string | null {
  const raw = cookies().get(INVITE_COOKIE)?.value || '';
  const slug = normalizeInviteCode(raw);
  return isInviteCodeFormat(slug) ? slug : null;
}

export function readInviteSource(): string {
  return normalizeInviteSource(cookies().get(INVITE_COOKIE_SRC)?.value || INVITE_SOURCE);
}

export function clearInviteCookieOn(res: NextResponse): void {
  res.cookies.set(INVITE_COOKIE, '', inviteCookieOptions(0));
  res.cookies.set(INVITE_COOKIE_SRC, '', inviteCookieOptions(0));
}
