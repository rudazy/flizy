import type { Metadata } from 'next';
import Link from 'next/link';
import { getSupabase } from '../../../lib/supabase';
import { resolvePayRef } from '../../../lib/payCode.ts';
import { decodeRouteParam } from '../../../lib/routeParam.ts';
import { pageMetadata } from '../../../lib/seo';
import { PayLanding } from '../../../components/PayLanding';
import { ExternalWalletProvider } from '../../../components/ExternalWalletProvider';
import { parsePayPreset } from '../../../lib/payLink.ts';
import { symbolLabel } from '../../../lib/listedTokens';

type Props = { params: { code: string }; searchParams?: Record<string, string | string[] | undefined> };

export function generateMetadata({ params, searchParams }: Props): Metadata {
  // A link with an amount says so in its chat preview. The note is left out:
  // it is anyone's text, and a preview card reads as Flizy speaking.
  const preset = parsePayPreset(searchParams);
  return pageMetadata({
    title: 'Pay on Flizy',
    description: preset.amount
      ? `A request for ${preset.amount} ${symbolLabel(preset.asset)} on Flizy. Open to review and pay.`
      : 'Pay a Flizy account by name. Scan the QR or open this link.',
    path: `/pay/${params.code || ''}`,
    noindex: true,
  });
}

export default async function PayCodePage({ params, searchParams }: Props) {
  const raw = decodeRouteParam(params.code);
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
