import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { pageMetadata } from '../../lib/seo';
import { getAccountIdFromCookie } from '../../lib/cookies';
import { safeNext } from '../../lib/safeNext.ts';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = pageMetadata({
  title: 'Log in to Flizy',
  description:
    'Sign in to your Flizy account to manage trusted people, your unlock PIN, and the link code for WhatsApp or Telegram.',
  path: '/login',
});

/** Already signed in: go where the link was headed instead of logging in twice. */
export default async function LoginPage({ searchParams }: { searchParams?: { next?: string } }) {
  if (await getAccountIdFromCookie()) redirect(safeNext(searchParams?.next));
  return <LoginForm />;
}
