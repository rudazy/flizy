/**
 * Whether the Privy login door is on.
 *
 * The only input is the public app id. An empty value leaves /login on the
 * email and password form. This module does not talk to Privy, does not read
 * an app secret, and does not decide who owns the Flizy account.
 */

import { safeNext } from './safeNext.ts';

const APP_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** Public GIWA Sepolia endpoint. Client code must not read a keyed RPC from the environment. */
export const CUSTODY_DOOR_CHAIN = {
  id: 91342,
  name: 'GIWA Sepolia',
  rpcUrl: 'https://sepolia-rpc.giwa.io',
  explorerUrl: 'https://sepolia-explorer.giwa.io',
} as const;

export const CUSTODY_DOOR_COPY = {
  kicker: 'Sign in',
  title: 'Log in or sign up',
  blurb:
    'Use a passkey, email, or Google. Continue as guest to look around on this device. Your Flizy account is a separate step.',
  passkey: 'Passkey',
  email: 'Email',
  google: 'Google',
  waiting: 'Checking sign-in',
  guest: 'Continue as guest',
  guestBusy: 'Starting guest',
  guestTitle: 'Guest',
  guestBody:
    'This is not a Flizy account. It stays on this device. Nothing is linked and nothing has moved.',
  guestUpgrade: 'Add a passkey, email, or Google',
  guestUpgradeNote: 'That starts a new login. To use an existing one, leave guest first.',
  guestLeave: 'Leave guest',
  guestUnavailable: 'Guest mode is not available yet.',
  password: 'Use email and password',
  signedInTitle: 'Signed in with Privy',
  signedInBody:
    'This wallet is not your Flizy account yet. Securing it comes next. Your passkey or your own wallet becomes the owner. Flizy keeps only a limited permission. Nothing has moved.',
  otherWays: 'Other ways to sign in',
  modalHeader: 'Log in or sign up',
  modalMessage: 'Passkey, email, or Google.',
} as const;

/**
 * Guest is Privy's guest account, not an external wallet and not a Flizy session.
 * A passkey, email, or Google login is the account path even if a wallet is also linked.
 */
export function custodyDoorIsGuest(user: { isGuest?: boolean } | null | undefined): boolean {
  return user?.isGuest === true;
}

export function custodyDoorAppId(value?: string | null): string {
  const raw = value === undefined ? process.env.NEXT_PUBLIC_PRIVY_APP_ID : value;
  const id = String(raw || '').trim();
  return APP_ID.test(id) ? id : '';
}

export function custodyDoorEnabled(value?: string | null): boolean {
  return custodyDoorAppId(value) !== '';
}

/** Existing password form, keeping a safe post-login path. */
export function passwordLoginHref(next: string | null | undefined): string {
  const params = new URLSearchParams();
  const dest = safeNext(next);
  if (dest !== '/dashboard') params.set('next', dest);
  params.set('door', 'password');
  const query = params.toString();
  return query ? `/login?${query}` : '/login';
}

/** Back to the door, without the password override. */
export function custodyDoorHref(next: string | null | undefined): string {
  const dest = safeNext(next);
  if (dest === '/dashboard') return '/login';
  return `/login?next=${encodeURIComponent(dest)}`;
}
