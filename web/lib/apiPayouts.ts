import { formatUnits, getAddress, isAddress, parseUnits } from 'ethers';
import { isCompleted, type ApiState } from './apiStates.ts';

/**
 * Flizy Pay API payouts: what a request may say, and what an answer shows.
 *
 * The site only validates and records; the VPS worker (lib/api/payoutWorker.js)
 * resolves the recipient and moves the money. So a valid request always gets
 * the same `accepted` answer, whoever the recipient is.
 *
 * 2a pays usernames and 0x addresses. A username's existence is already
 * public (flizy.app/u/<name> answers 404 for a name that is not taken), so a
 * payout to one that is not payable failing says nothing new. Phone, email and
 * platform ids arrive in 2b as claims, which never reveal membership.
 *
 * Imports only ethers and apiStates, so node --test loads this file directly.
 */

/** API asset name to symbol, label and decimals. The worker has the same table (lib/api/payoutWorker.js ASSETS). */
export const PAYOUT_ASSETS = {
  ETH: { symbol: 'ETH', label: 'ETH', decimals: 18 },
  FLZ: { symbol: 'FLZ', label: 'FLZ', decimals: 18 },
  TUSD: { symbol: 'TUSD', label: 'tUSD', decimals: 6 },
} as const;
export type PayoutSymbol = keyof typeof PAYOUT_ASSETS;

/** Same rule as lib/payCode.js resolvePayRef. */
const USERNAME_RE = /^[a-z][a-z0-9]{2,23}$/;
const REFERENCE_MAX = 120;
const METADATA_MAX_BYTES = 2048;

type PayoutRequest = {
  symbol: PayoutSymbol;
  amount: bigint;
  recipient: { type: 'username' | 'address'; value: string };
  reference: string | null;
  metadata: Record<string, unknown> | null;
};

export class PayoutRequestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Accepts ETH, FLZ and tUSD in any case. */
export function payoutSymbol(raw: unknown): PayoutSymbol | null {
  const s = String(raw ?? '').trim().toUpperCase();
  return s in PAYOUT_ASSETS ? (s as PayoutSymbol) : null;
}

/** A positive decimal string with no more places than the asset has, in base units. */
export function parsePayoutAmount(raw: unknown, symbol: PayoutSymbol): bigint | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/.test(s)) return null;
  const places = s.includes('.') ? s.split('.')[1].length : 0;
  if (places > PAYOUT_ASSETS[symbol].decimals) return null;
  const units = parseUnits(s, PAYOUT_ASSETS[symbol].decimals);
  return units > 0n ? units : null;
}

/** The recipient a request names, or a PayoutRequestError. */
export function parseRecipient(raw: unknown): PayoutRequest['recipient'] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { type?: unknown; value?: unknown };
  const type = String(r.type ?? '');
  const value = String(r.value ?? '').trim();
  if (type === 'username') {
    const name = value.replace(/^@/, '').toLowerCase();
    if (!USERNAME_RE.test(name)) throw new PayoutRequestError('invalid_recipient', 'recipient.value is not a valid Flizy username.');
    return { type, value: name };
  }
  if (type === 'address') {
    if (!isAddress(value)) throw new PayoutRequestError('invalid_recipient', 'recipient.value is not a valid 0x address.');
    const address = getAddress(value);
    if (/^0x0{40}$/i.test(address)) throw new PayoutRequestError('invalid_recipient', 'recipient.value cannot be the zero address.');
    return { type, value: address.toLowerCase() };
  }
  if (['phone', 'email', 'telegram', 'discord', 'github'].includes(type)) {
    throw new PayoutRequestError('recipient_type_not_supported', `Payouts to ${type} are not available yet.`);
  }
  throw new PayoutRequestError('invalid_recipient', 'recipient.type must be username or address.');
}

/** The whole request body, validated, or a PayoutRequestError. Unknown fields are refused. */
export function parsePayoutRequest(body: unknown): PayoutRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PayoutRequestError('invalid_request', 'The body must be a JSON object.');
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !['amount', 'asset', 'recipient', 'reference', 'metadata'].includes(k));
  if (unknown.length) throw new PayoutRequestError('invalid_request', `Unknown field: ${unknown[0].slice(0, 40)}.`);
  const symbol = payoutSymbol(b.asset);
  if (!symbol) throw new PayoutRequestError('invalid_asset', 'asset must be ETH, FLZ or tUSD.');
  const amount = parsePayoutAmount(b.amount, symbol);
  if (amount == null) {
    throw new PayoutRequestError('invalid_amount', `amount must be a positive decimal string with at most ${PAYOUT_ASSETS[symbol].decimals} places.`);
  }
  const recipient = parseRecipient(b.recipient);
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
  return { symbol, amount, recipient, reference, metadata };
}

export type PayoutRow = {
  id: string;
  state: ApiState;
  amount: string;
  asset: string;
  recipient_kind: string;
  recipient_ref: string;
  reference: string | null;
  metadata: Record<string, unknown> | null;
  tx_hash: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

export const PAYOUT_COLUMNS = 'id, state, amount, asset, recipient_kind, recipient_ref, reference, metadata, tx_hash, error_code, created_at, updated_at';

/** "10.5" for 10.5, "20" for 20.0: formatUnits always keeps a decimal point. */
export function plainAmount(units: bigint, decimals: number): string {
  const s = formatUnits(units, decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** What the API shows for one payout. `completed` is true only for confirmed (and, later, refunded). */
export function payoutView(row: PayoutRow) {
  const asset = PAYOUT_ASSETS[row.asset as PayoutSymbol];
  return {
    id: row.id,
    object: 'payout',
    state: row.state,
    completed: isCompleted(row.state),
    amount: asset ? plainAmount(BigInt(row.amount), asset.decimals) : row.amount,
    asset: asset ? asset.label : row.asset,
    recipient: { type: row.recipient_kind, value: row.recipient_ref },
    reference: row.reference,
    metadata: row.metadata,
    tx_hash: row.tx_hash,
    error_code: row.error_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
