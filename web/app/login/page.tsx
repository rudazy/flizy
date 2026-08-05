import type { Metadata } from 'next';
import { pageMetadata } from '../../lib/seo';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = pageMetadata({
  title: 'Log in to Flizy',
  description:
    'Sign in to your Flizy account to manage trusted people, your unlock PIN, and the link code for WhatsApp or Telegram.',
  path: '/login',
});

export default function LoginPage() {
  return <LoginForm />;
}
