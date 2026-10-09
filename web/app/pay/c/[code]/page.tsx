import type { Metadata } from 'next';
import Link from 'next/link';
import { getSupabase } from '../../../../lib/supabase';
import { resolvePayCode } from '../../../../lib/payCode.ts';
import { decodeRouteParam } from '../../../../lib/routeParam.ts';
import { pageMetadata } from '../../../../lib/seo';
import { PayLanding } from '../../../../components/PayLanding';

/**
 * /pay/c/{code} — the routing identifier, on its own path.
 *
 * `/pay/{ref}` accepts either a username or a pay code and resolves usernames
 * first. When codes were 6 alphanumeric characters they lowercased into valid
 * usernames, so anyone could read a shop's code off its printed QR, register it
 * as their username, and quietly collect that shop's payments. Nine digits
 * closed that hole at the format level -- a code can no longer be a username.
 *
 * This route stays anyway, and printed paper points here rather than at
 * `/pay/{ref}`. It resolves the pay code and nothing else, so the thing taped
 * to a counter does not depend on the name namespace staying disjoint for the
 * rest of the product's life. `/pay/{ref}` is unchanged for typed and shared
 * links.
 */

type Props = { params: { code: string } };

export function generateMetadata({ params }: Props): Metadata {
  return pageMetadata({
    title: 'Pay on Flizy',
    description: 'Pay a Flizy account. Scan the QR or open this link.',
    path: `/pay/c/${params.code || ''}`,
    noindex: true,
  });
}

export default async function PayByCodePage({ params }: Props) {
  const raw = decodeRouteParam(params.code);

  let found: Awaited<ReturnType<typeof resolvePayCode>> = null;
  try {
    found = await resolvePayCode(getSupabase(), raw);
  } catch {
    found = null;
  }

  if (!found) {
    return (
      <div className="fade-up mx-auto max-w-md space-y-4">
        <h1 className="font-sans text-3xl tracking-wide text-paper">Not found</h1>
        <p className="text-sm text-muted">No Flizy account matches that Flizy number.</p>
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
