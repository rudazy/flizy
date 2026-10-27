import type { Metadata } from 'next';
import { PeopleFinder } from '../../components/PeopleFinder';
import { pageMetadata } from '../../lib/seo';

/**
 * Find a username and open that profile. Suggestions are filled only when
 * someone has already followed a profile.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata({
  title: 'People | Flizy',
  description: 'Find a Flizy username and open their profile.',
  path: '/people',
  noindex: true,
});

export default async function PeoplePage({ searchParams }: { searchParams?: { q?: string } }) {
  // A username is at most 24 characters. Anything longer is not a search.
  const raw = typeof searchParams?.q === 'string' ? searchParams.q.trim() : '';
  return <PeopleFinder initialQuery={raw.slice(0, 24)} />;
}
