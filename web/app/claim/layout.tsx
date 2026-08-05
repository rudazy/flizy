import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { pageMetadata } from '../../lib/seo';

/**
 * Claim URLs carry a one-time token. They stay disallowed in robots.txt so the
 * token is never crawled; this noindex is the second layer for anywhere a link
 * leaks (chat previews, pasted URLs).
 */
export const metadata: Metadata = pageMetadata({
  title: 'Claim | Flizy',
  description: 'Claim funds someone reserved for you on Flizy.',
  path: '/claim',
  noindex: true,
});

export default function ClaimLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
