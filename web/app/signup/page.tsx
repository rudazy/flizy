import type { Metadata } from 'next';
import { pageMetadata } from '../../lib/seo';
import { SignupForm } from './SignupForm';

/**
 * Server shell so this route can own its metadata. The form itself stays a
 * client component — client components cannot export `metadata`, which is why
 * this page previously inherited the homepage title and canonical.
 */
export const metadata: Metadata = pageMetadata({
  title: 'Create your Flizy account',
  description:
    'Open a free Flizy account, add the people you trust, and link WhatsApp or Telegram with a one-time code. No seed phrase in chat.',
  path: '/signup',
});

export default function SignupPage() {
  return <SignupForm />;
}
