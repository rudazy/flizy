import type { Metadata } from 'next';
import { getSupabase } from '../../../lib/supabase';
import { pageMetadata } from '../../../lib/seo';
import { loadCheckout } from '../../../lib/checkout.ts';
import { PAYOUT_ASSETS } from '../../../lib/apiPayouts.ts';
import { ExternalWalletProvider } from '../../../components/ExternalWalletProvider';
import { CheckoutPay } from '../../../components/CheckoutPay';

/**
 * A Flizy Pay API checkout: a platform's customer pays it from any wallet,
 * straight to the platform's wallet (web/lib/checkout.ts). Never indexed. A
 * checkout that is paid, expired or unknown, or whose platform Flizy paused,
 * says so and offers nothing to pay.
 */

type Props = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { id } = await props.params;
  return pageMetadata({ title: 'Checkout on Flizy', description: 'Pay this checkout from your wallet.', path: `/checkout/${id || ''}`, noindex: true });
}

export default async function CheckoutPage(props: Props) {
  const { id } = await props.params;
  let view: Awaited<ReturnType<typeof loadCheckout>> = null;
  if (UUID.test(String(id || ''))) {
    try {
      view = await loadCheckout(getSupabase(), id);
    } catch {
      view = null;
    }
  }
  if (!view) {
    return (
      <div className="fade-up mx-auto max-w-md space-y-4">
        <h1 className="font-sans text-3xl tracking-wide text-paper">Checkout not found</h1>
        <p className="text-sm text-muted">This link does not match a checkout. Ask the shop for a new one.</p>
      </div>
    );
  }

  const open = view.state === 'accepted' && Date.parse(view.expiresAt) > Date.now();
  // A platform Flizy paused takes no new payments here, whatever its links say.
  const payable = open && view.platformEnabled;
  const paid = view.state === 'submitted' || view.state === 'confirmed';
  const back = view.returnUrl ? new URL(view.returnUrl) : null;

  return (
    <div className="fade-up mx-auto max-w-md space-y-5">
      <div className="card space-y-2 p-6">
        <p className="m-0 text-xs uppercase tracking-[0.18em] text-muted">Checkout for {view.platformName}</p>
        <p className="m-0 font-sans text-3xl tracking-wide text-paper">
          {view.amount} {view.assetLabel}
        </p>
        {view.received !== '0' && !paid ? (
          <p className="m-0 text-sm text-muted">
            Received {view.received} {view.assetLabel} so far.
          </p>
        ) : null}
        <p className="m-0 text-xs text-muted">
          Paid on GIWA Sepolia straight to {view.platformName}&apos;s wallet ({view.payee.slice(0, 6)}...{view.payee.slice(-4)}). Flizy never holds it.
        </p>
      </div>

      {paid ? (
        <div className="alert alert-ok text-sm">
          Paid. The payment reached {view.platformName}&apos;s wallet.
          {view.overpaid ? ' More than the amount arrived; the shop can send back the difference.' : ''}
        </div>
      ) : payable ? (
        <ExternalWalletProvider>
          <CheckoutPay
            id={view.id}
            amount={view.amount}
            assetLabel={view.assetLabel}
            asset={view.asset}
            decimals={PAYOUT_ASSETS[view.asset].decimals}
            payee={view.payee as `0x${string}`}
            invoiceId={view.invoiceId as `0x${string}`}
            token={view.token as `0x${string}` | null}
            platformName={view.platformName}
          />
        </ExternalWalletProvider>
      ) : open ? (
        <div className="alert text-sm">This checkout is not available. Do not pay it.</div>
      ) : (
        <div className="alert text-sm">This checkout has expired. Ask the shop for a new one; do not pay this one.</div>
      )}

      {back ? (
        <a href={back.toString()} rel="noreferrer noopener" className="block text-center text-sm text-sun no-underline hover:opacity-80">
          Back to {back.host}
        </a>
      ) : null}
    </div>
  );
}
