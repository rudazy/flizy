import type { Metadata } from 'next';
import { PeopleFinder } from '../../components/PeopleFinder';
import { getAccountIdFromCookie } from '../../lib/cookies';
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

export default async function PeoplePage() {
  const signedIn = Boolean(await getAccountIdFromCookie().catch(() => null));
  return <PeopleFinder signedIn={signedIn} />;
}
