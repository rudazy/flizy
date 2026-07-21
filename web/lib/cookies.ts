import { cookies } from 'next/headers';

const COOKIE = 'flizy_account';

export function setAccountCookie(accountId: string) {
  cookies().set(COOKIE, accountId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearAccountCookie() {
  cookies().set(COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 });
}

export function getAccountIdFromCookie(): string | null {
  return cookies().get(COOKIE)?.value || null;
}
