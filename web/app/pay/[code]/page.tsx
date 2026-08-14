import type { Metadata } from 'next';
import Link from 'next/link';
import { getSupabase } from '../../../lib/supabase';
import { resolvePayRef } from '../../../lib/payCode.ts';
import { pageMetadata } from '../../../lib/seo';
import { PayLanding } from '../../../components/PayLanding';

type Props = { params: { code: string } };

export function generateMetadata({ params }: Props): Metadata {
  return pageMetadata({
    title: 'Pay on Flizy',
    description: 'Pay a Flizy account by name. Scan the QR or open this link.',
    path: `/pay/${params.code || ''}`,
    noindex: true,
  });
}

export default async function PayCodePage({ params }: Props) {
  const raw = String(params.code || '');
  let found: Awaited<ReturnType<typeof resolvePayRef>> = null;
  try {
    found = await resolvePayRef(getSupabase(), raw);
  } catch {
    found = null;
  }

  if (!found) {
    return (
      <div className="fade-up mx-auto max-w-md space-y-4">
        <h1 className="font-sans text-3xl tracking-wide text-paper">Not found</h1>
        <p className="text-sm text-muted">No Flizy account matches that name or code.</p>
        <Link href="/" className="text-sm text-lime no-underline hover:text-gold">
          Home
        </Link>
      </div>
    );
  }

  return (
    <PayLanding
      refSlug={found.username || found.code || raw}
      username={found.username}
      displayName={found.displayName}
    />
  );
}
