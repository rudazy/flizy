import type { Metadata } from 'next';
import Link from 'next/link';
import { getSupabase } from '../../../../lib/supabase';
import { resolvePayCode } from '../../../../lib/payCode.ts';
import { decodeRouteParam } from '../../../../lib/routeParam.ts';
import { pageMetadata } from '../../../../lib/seo';
import { PayLanding } from '../../../../components/PayLanding';
import { ExternalWalletProvider } from '../../../../components/ExternalWalletProvider';
import { parsePayPreset } from '../../../../lib/payLink.ts';
import { symbolLabel } from '../../../../lib/listedTokens';

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

type Props = { params: { code: string }; searchParams?: Record<string, string | string[] | undefined> };

export function generateMetadata({ params, searchParams }: Props): Metadata {
  // A link with an amount says so in its chat preview. The note is left out:
  // it is anyone's text, and a preview card reads as Flizy speaking.
  const preset = parsePayPreset(searchParams);
  return pageMetadata({
    title: 'Pay on Flizy',
    description: preset.amount
      ? `A request for ${preset.amount} ${symbolLabel(preset.asset)} on Flizy. Open to review and pay.`
      : 'Pay a Flizy account. Scan the QR or open this link.',
    path: `/pay/c/${params.code || ''}`,
    noindex: true,
  });
}

export default async function PayByCodePage({ params, searchParams }: Props) {
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

  // Outside-wallet pay is offered only where the owner turned it on.
  let outsidePay = false;
  try {
    const { data } = await getSupabase().from('accounts').select('accept_outside_pay').eq('id', found.accountId).maybeSingle();
    outsidePay = data?.accept_outside_pay === true;
  } catch {
    outsidePay = false;
  }

  return (
    <ExternalWalletProvider>
    <PayLanding
      refSlug={found.username || found.code || raw}
      username={found.username}
      displayName={found.displayName}
      preset={parsePayPreset(searchParams)}
      outsidePay={outsidePay}
    />
    </ExternalWalletProvider>
  );
}
