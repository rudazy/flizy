import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { displaySafeLabel } from './sanitize.ts';
import { PAYOUT_ASSETS, plainAmount, type PayoutSymbol } from './apiPayouts.ts';
import { matchCheckoutPayments } from './apiPayments.ts';
import { paymentsInReceipt, type ExternalPayment } from './externalPay.ts';
import { listedBySymbol } from './listedTokens';
import { getDexAddresses } from './dexServer';

/**
 * The public side of a Flizy Pay API payment: what flizy.app/checkout/<id>
 * shows a payer, and the check of a payment they report.
 *
 * The page shows only what paying needs: the platform's Flizy-assigned name,
 * the amount, the wallet it goes to, the invoice id to put on chain, and the
 * state. Never the platform's reference or metadata, which can name its
 * customer. The id is a random UUID, so a checkout is found only through the
 * link the platform gave its customer.
 *
 * A reported transaction is believed only as a pointer: its receipt must hold a
 * PaymentReceived log from FlizyPaymentReceiver with this checkout's invoice
 * id, to the platform's wallet, in the checkout's asset (externalPay.ts
 * paymentsInReceipt checks the emitter, payee and token). Each one is recorded
 * once by api_record_payment, the same function the VPS watcher uses.
 */

type CheckoutView = {
  id: string;
  state: string;
  platformName: string;
  amount: string;
  asset: PayoutSymbol;
  assetLabel: string;
  received: string;
  overpaid: boolean;
  payee: string;
  invoiceId: string;
  token: string | null;
  expiresAt: string;
  returnUrl: string | null;
  /** False while Flizy has paused the platform: the page then offers no way to pay. */
  platformEnabled: boolean;
};

type Row = {
  id: string;
  platform_id: string;
  state: string;
  amount: string;
  asset: string;
  received_units: string | number;
  overpaid: boolean;
  invoice_id: string;
  expires_at: string;
  return_url: string | null;
};

/** The token a payer sends for an asset; null for ETH. */
function checkoutToken(asset: PayoutSymbol): string | null {
  if (asset === 'ETH') return null;
  if (asset === 'TUSD') return ethers.getAddress(String(listedBySymbol('TUSD')?.address || ''));
  return ethers.getAddress(getDexAddresses().flz);
}

async function loadRow(db: SupabaseClient, id: string): Promise<{ row: Row; platform: { account_id: string; display_name: string; wallet_address: string; enabled: boolean } } | null> {
  const { data: row, error } = await db
    .from('api_transactions')
    .select('id, platform_id, state, amount, asset, received_units, overpaid, invoice_id, expires_at, return_url')
    .eq('id', id)
    .eq('kind', 'payment')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) return null;
  const { data: platform, error: pErr } = await db
    .from('api_platforms')
    .select('account_id, display_name, wallet_address, enabled')
    .eq('id', (row as Row).platform_id)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!platform) return null;
  return { row: row as Row, platform };
}

export async function loadCheckout(db: SupabaseClient, id: string): Promise<CheckoutView | null> {
  const found = await loadRow(db, id);
  if (!found) return null;
  const { row, platform } = found;
  const asset = row.asset as PayoutSymbol;
  const meta = PAYOUT_ASSETS[asset];
  if (!meta) return null;
  return {
    id: row.id,
    state: row.state,
    platformName: displaySafeLabel(platform.display_name, 60) || 'A Flizy partner',
    amount: plainAmount(BigInt(row.amount), meta.decimals),
    asset,
    assetLabel: meta.label,
    received: plainAmount(BigInt(String(row.received_units ?? 0)), meta.decimals),
    overpaid: row.overpaid === true,
    payee: ethers.getAddress(platform.wallet_address),
    invoiceId: row.invoice_id,
    token: checkoutToken(asset),
    expiresAt: row.expires_at,
    returnUrl: row.return_url,
    platformEnabled: platform.enabled === true,
  };
}

/** The payments in a receipt that belong to this checkout: its invoice id, its wallet, its asset. */
export function checkoutPaymentsIn(receipt: Parameters<typeof paymentsInReceipt>[0], view: { payee: string; invoiceId: string; asset: string }): ExternalPayment[] {
  return matchCheckoutPayments(paymentsInReceipt(receipt, view.payee), view);
}

/** Record each of them once. Returns what api_record_payment said for each. */
export async function recordCheckoutPayments(db: SupabaseClient, id: string, txHash: string, payments: ExternalPayment[]): Promise<string[]> {
  const found = await loadRow(db, id);
  if (!found) return [];
  const out: string[] = [];
  for (const p of payments) {
    const { data, error } = await db.rpc('api_record_payment', {
      p_transaction_id: id,
      p_tx_hash: txHash.toLowerCase(),
      p_log_index: p.logIndex,
      p_payer: p.payer,
      p_units: p.units.toString(),
      p_payee_account_id: found.platform.account_id,
      p_payee_address: p.payee,
      p_asset: p.asset,
      p_token_address: p.asset === 'ETH' ? null : p.token,
      p_amount_text: String(p.amount),
    });
    if (error) throw new Error(error.message);
    out.push(String(data));
  }
  return out;
}
