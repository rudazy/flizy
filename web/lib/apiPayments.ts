import { randomBytes } from 'crypto';
import { isCompleted, type ApiState } from './apiStates.ts';
import { PAYOUT_ASSETS, PayoutRequestError, parsePayoutAmount, payoutSymbol, plainAmount, type PayoutSymbol } from './apiPayouts.ts';

/**
 * Flizy Pay API payments: checkouts a platform's customers pay from any wallet.
 *
 * A payment has a server-chosen invoice id (32 random bytes). The customer pays
 * on flizy.app/checkout/<id> through FlizyPaymentReceiver, which forwards the
 * whole amount to the platform's approved wallet in the same transaction and
 * logs the invoice id; Flizy never holds it. The database records each
 * on-chain payment once and settles the checkout when the payments reach the
 * amount (supabase/migrations/20261110120000_api_payments.sql,
 * api_record_payment).
 *
 * A return link after paying is allowed only on an origin the platform
 * registered, so the checkout can never send a payer to an arbitrary site.
 *
 * Imports only crypto and sibling pure modules, so node --test loads it.
 */

const EXPIRY_MIN_MINUTES = 5;
const EXPIRY_MAX_MINUTES = 7 * 24 * 60;
const EXPIRY_DEFAULT_MINUTES = 60;
export const MAX_ORIGINS = 5;

const REFERENCE_MAX = 120;
const METADATA_MAX_BYTES = 2048;

type PaymentRequest = {
  symbol: PayoutSymbol;
  amount: bigint;
  reference: string | null;
  metadata: Record<string, unknown> | null;
  expiresInMinutes: number;
  returnUrl: string | null;
};

/** A fresh invoice id, as FlizyPaymentReceiver takes it: 32 random bytes. */
export function newInvoiceId(): string {
  return '0x' + randomBytes(32).toString('hex');
}

/** An origin a platform may register: https, a host name (no IP, no port, no path). */
export function cleanOrigin(raw: unknown): string | null {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (/^[0-9.]+$/.test(host) || host.includes(':') || !host.includes('.') || host === 'localhost' || host.endsWith('.local')) return null;
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return null;
  return `https://${host}`;
}

/** The return URL, when it is https on one of the platform's registered origins; otherwise null. */
export function allowedReturnUrl(raw: string, origins: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || raw.length > 2000) return null;
  return origins.includes(url.origin.toLowerCase()) ? url.toString() : null;
}

/** The whole request body, validated, or a PayoutRequestError (same codes as payouts). */
export function parsePaymentRequest(body: unknown): PaymentRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PayoutRequestError('invalid_request', 'The body must be a JSON object.');
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !['amount', 'asset', 'reference', 'metadata', 'expires_in_minutes', 'return_url'].includes(k));
  if (unknown.length) throw new PayoutRequestError('invalid_request', `Unknown field: ${unknown[0].slice(0, 40)}.`);
  const symbol = payoutSymbol(b.asset);
  if (!symbol) throw new PayoutRequestError('invalid_asset', 'asset must be ETH, FLZ or tUSD.');
  const amount = parsePayoutAmount(b.amount, symbol);
  if (amount == null) {
    throw new PayoutRequestError('invalid_amount', `amount must be a positive decimal string with at most ${PAYOUT_ASSETS[symbol].decimals} places.`);
  }
  let reference: string | null = null;
  if (b.reference != null) {
    if (typeof b.reference !== 'string' || b.reference.length > REFERENCE_MAX || /[\u0000-\u001f\u007f]/.test(b.reference)) {
      throw new PayoutRequestError('invalid_reference', `reference must be text of at most ${REFERENCE_MAX} characters.`);
    }
    reference = b.reference;
  }
  let metadata: Record<string, unknown> | null = null;
  if (b.metadata != null) {
    if (typeof b.metadata !== 'object' || Array.isArray(b.metadata)) throw new PayoutRequestError('invalid_metadata', 'metadata must be an object.');
    if (Buffer.byteLength(JSON.stringify(b.metadata), 'utf8') > METADATA_MAX_BYTES) {
      throw new PayoutRequestError('invalid_metadata', `metadata must be at most ${METADATA_MAX_BYTES} bytes of JSON.`);
    }
    metadata = b.metadata as Record<string, unknown>;
  }
  let expiresInMinutes = EXPIRY_DEFAULT_MINUTES;
  if (b.expires_in_minutes != null) {
    const m = b.expires_in_minutes;
    if (!Number.isInteger(m) || (m as number) < EXPIRY_MIN_MINUTES || (m as number) > EXPIRY_MAX_MINUTES) {
      throw new PayoutRequestError('invalid_expiry', `expires_in_minutes must be a whole number from ${EXPIRY_MIN_MINUTES} to ${EXPIRY_MAX_MINUTES}.`);
    }
    expiresInMinutes = m as number;
  }
  let returnUrl: string | null = null;
  if (b.return_url != null) {
    if (typeof b.return_url !== 'string') throw new PayoutRequestError('invalid_return_url', 'return_url must be a URL.');
    returnUrl = b.return_url;
  }
  return { symbol, amount, reference, metadata, expiresInMinutes, returnUrl };
}

export type PaymentRow = {
  id: string;
  state: ApiState;
  amount: string;
  asset: string;
  reference: string | null;
  metadata: Record<string, unknown> | null;
  received_units: string | number;
  overpaid: boolean;
  expires_at: string;
  return_url: string | null;
  tx_hash: string | null;
  settled_at: string | null;
  created_at: string;
  updated_at: string;
};

export const PAYMENT_COLUMNS =
  'id, state, amount, asset, reference, metadata, received_units, overpaid, expires_at, return_url, tx_hash, settled_at, created_at, updated_at';

/** What the API shows for one payment. `completed` only once it settled (confirmed). */
export function paymentView(row: PaymentRow, siteUrl: string) {
  const asset = PAYOUT_ASSETS[row.asset as PayoutSymbol];
  const units = (v: string | number) => (asset ? plainAmount(BigInt(String(v)), asset.decimals) : String(v));
  return {
    id: row.id,
    object: 'payment',
    state: row.state,
    completed: isCompleted(row.state),
    amount: units(row.amount),
    asset: asset ? asset.label : row.asset,
    received: units(row.received_units ?? 0),
    overpaid: row.overpaid === true,
    checkout_url: `${siteUrl.replace(/\/$/, '')}/checkout/${row.id}`,
    reference: row.reference,
    metadata: row.metadata,
    expires_at: row.expires_at,
    return_url: row.return_url,
    tx_hash: row.tx_hash,
    settled_at: row.settled_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class OriginRequestError extends Error {}

type OriginDb = { from: (table: string) => unknown };
type OriginQuery = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> & {
  select(cols: string): OriginQuery;
  insert(values: Record<string, unknown>): OriginQuery;
  delete(): OriginQuery;
  eq(col: string, value: unknown): OriginQuery;
  order(col: string, opts: { ascending: boolean }): OriginQuery;
};
const origins = (db: OriginDb) => db.from('api_platform_origins') as OriginQuery;

/** The origins a checkout may send the payer back to, for this platform. */
export async function listOrigins(db: OriginDb, platformId: string): Promise<string[]> {
  const { data, error } = await origins(db).select('origin').eq('platform_id', platformId).order('created_at', { ascending: true });
  if (error) throw new Error(error.message || 'origin read failed');
  return ((data as Array<{ origin: string }>) || []).map((o) => o.origin);
}

/** Register one more origin. At most MAX_ORIGINS; checked again after the insert, so two at once cannot both pass. */
export async function addOrigin(db: OriginDb, platformId: string, raw: unknown): Promise<string> {
  const origin = cleanOrigin(raw);
  if (!origin) throw new OriginRequestError('Enter your site as https://your-domain.com (a host name, no path or port).');
  const now = await listOrigins(db, platformId);
  if (now.includes(origin)) return origin;
  if (now.length >= MAX_ORIGINS) throw new OriginRequestError(`A platform can register ${MAX_ORIGINS} sites. Remove one first.`);
  const { error } = await origins(db).insert({ platform_id: platformId, origin });
  if (error && error.code !== '23505') throw new Error(error.message || 'origin insert failed');
  if ((await listOrigins(db, platformId)).length > MAX_ORIGINS) {
    await origins(db).delete().eq('platform_id', platformId).eq('origin', origin);
    throw new OriginRequestError(`A platform can register ${MAX_ORIGINS} sites. Remove one first.`);
  }
  return origin;
}

/** Remove one. Checkouts already made keep the return link they were given. */
export async function removeOrigin(db: OriginDb, platformId: string, raw: unknown): Promise<boolean> {
  const origin = cleanOrigin(raw);
  if (!origin) return false;
  const { data, error } = await origins(db).delete().eq('platform_id', platformId).eq('origin', origin).select('origin');
  if (error) throw new Error(error.message || 'origin delete failed');
  return Array.isArray(data) && data.length > 0;
}

/**
 * The payments, among those a receipt holds for the platform's wallet, that
 * belong to this checkout: its invoice id and its asset. (Which logs come from
 * FlizyPaymentReceiver and pay the platform's wallet is externalPay.ts
 * paymentsInReceipt's job, tested there.)
 */
export function matchCheckoutPayments<T extends { invoiceId: string; asset: string }>(payments: T[], checkout: { invoiceId: string; asset: string }): T[] {
  const id = checkout.invoiceId.toLowerCase();
  return payments.filter((p) => p.invoiceId.toLowerCase() === id && p.asset === checkout.asset);
}
