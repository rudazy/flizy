import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { pageMetadata } from '../../lib/seo';

/** The stop link carries a claim token: never indexed, like /claim. */
export const metadata: Metadata = pageMetadata({
  title: 'Stop emails | Flizy',
  description: 'Stop Flizy payment emails to this address.',
  path: '/email/stop',
  noindex: true,
});

export default function EmailLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
