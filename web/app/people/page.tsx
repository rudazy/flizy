import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PeopleFinder } from '../../components/PeopleFinder';
import { pageMetadata } from '../../lib/seo';
import { featureOn } from '../../lib/features.ts';

/**
 * Find a username and open that profile. Suggestions are filled only when
 * someone has already followed a profile. Not found while following is paused
 * (web/lib/features.ts); a profile itself stays open as a pay page.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata({
  title: 'People | Flizy',
  description: 'Find a Flizy username and open their profile.',
  path: '/people',
  noindex: true,
});

export default async function PeoplePage(props: { searchParams: Promise<{ q?: string }> }) {
  if (!featureOn('follows')) notFound();
  const searchParams = await props.searchParams;
  // A username is at most 24 characters. Anything longer is not a search.
  const raw = typeof searchParams?.q === 'string' ? searchParams.q.trim() : '';
  return <PeopleFinder initialQuery={raw.slice(0, 24)} />;
}
