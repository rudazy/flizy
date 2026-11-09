import type { Metadata } from 'next';
import { getSupabase } from '../../../lib/supabase';
import { pageMetadata } from '../../../lib/seo';
import { loadCheckout } from '../../../lib/checkout.ts';
import { PAYOUT_ASSETS, plainAmount } from '../../../lib/apiPayouts.ts';
import { ExternalWalletProvider } from '../../../components/ExternalWalletProvider';
import { CheckoutPay } from '../../../components/CheckoutPay';
import { CheckoutAccountPay } from '../../../components/CheckoutAccountPay';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { checkoutChatLinks } from '../../../lib/checkoutChat.ts';

/**
 * A Flizy Pay API checkout: a platform's customer pays it from any wallet, or
 * from their Flizy wallet when signed in or in chat, straight to the platform's
 * wallet (web/lib/checkout.ts). Every way pays what is still due. Never indexed.
 * A checkout that is paid, expired or unknown, or whose platform Flizy paused,
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
  // A signed-in Flizy user other than the platform itself may pay from their Flizy wallet.
  const accountId = payable ? await getAccountIdFromCookie().catch(() => null) : null;
  // What is still due: the whole amount, or the rest after a partial payment.
  const due = plainAmount(view.amountUnits - view.receivedUnits, PAYOUT_ASSETS[view.asset].decimals);
  const chat = payable ? checkoutChatLinks(view.id) : { telegram: null, whatsapp: null };

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
        <div className="space-y-4">
        {accountId && accountId !== view.platformAccountId ? (
          <div className="card space-y-3 p-6">
            <p className="m-0 text-xs uppercase tracking-[0.18em] text-muted">With your Flizy account</p>
            <CheckoutAccountPay id={view.id} amount={due} assetLabel={view.assetLabel} platformName={view.platformName} />
          </div>
        ) : null}
        {chat.telegram || chat.whatsapp ? (
          <div className="card space-y-3 p-6">
            <p className="m-0 text-xs uppercase tracking-[0.18em] text-muted">In chat</p>
            <p className="m-0 text-sm text-muted">Pay {due} {view.assetLabel} from the Flizy account your chat is linked to.</p>
            <div className={`grid gap-2.5 ${chat.telegram && chat.whatsapp ? 'sm:grid-cols-2' : ''}`}>
              {chat.telegram ? (
                <a href={chat.telegram} target="_blank" rel="noreferrer noopener" className="btn btn-ghost w-full py-3 text-sm no-underline">
                  Pay in Telegram
                </a>
              ) : null}
              {chat.whatsapp ? (
                <a href={chat.whatsapp} target="_blank" rel="noreferrer noopener" className="btn btn-ghost w-full py-3 text-sm no-underline">
                  Pay in WhatsApp
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
        <ExternalWalletProvider>
          <CheckoutPay
            id={view.id}
            amount={due}
            assetLabel={view.assetLabel}
            asset={view.asset}
            decimals={PAYOUT_ASSETS[view.asset].decimals}
            payee={view.payee as `0x${string}`}
            invoiceId={view.invoiceId as `0x${string}`}
            token={view.token as `0x${string}` | null}
            platformName={view.platformName}
          />
        </ExternalWalletProvider>
        </div>
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
