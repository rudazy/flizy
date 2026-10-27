import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PublicProfile } from '../../../components/PublicProfile';
import { ClientError } from '../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { loadProfile } from '../../../lib/followStore.ts';
import { pageMetadata } from '../../../lib/seo';
import { validateUsername } from '../../../lib/username.ts';

/**
 * Public profile. A reader does not need an account or a wallet to open it.
 * Follow is offered on the page and stays separate from Pay.
 */

export const dynamic = 'force-dynamic';

type Props = { params: { username: string }; searchParams?: { list?: string } };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const checked = validateUsername(params.username);
  const name = checked.ok ? checked.username : 'profile';
  return pageMetadata({
    title: checked.ok ? `@${checked.username} | Flizy` : 'Profile | Flizy',
    description: checked.ok ? `Profile for @${checked.username} on Flizy.` : 'A Flizy profile.',
    path: checked.ok ? `/u/${name}` : '/people',
    noindex: true,
  });
}

export default async function UserProfilePage({ params, searchParams }: Props) {
  const list = searchParams?.list === 'followers' || searchParams?.list === 'following' ? searchParams.list : null;
  const viewerId = await getAccountIdFromCookie().catch(() => null);
  try {
    const profile = await loadProfile(params.username, viewerId);
    if (!profile) notFound();
    return <PublicProfile profile={profile} initialList={list} />;
  } catch (err) {
    if (err instanceof ClientError) {
      return (
        <div className="mx-auto w-full max-w-lg rounded-[16px] border border-[#2a2b30] bg-[#101012] px-4 py-6 md:max-w-3xl">
          <p className="m-0 font-sans text-[14px] text-[#c8c2b8]">{err.message}</p>
        </div>
      );
    }
    throw err;
  }
}
