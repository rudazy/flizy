import { formatUnits, getAddress, isAddress, parseUnits } from 'ethers';
import { isCompleted, type ApiState } from './apiStates.ts';

/**
 * Flizy Pay API payouts: what a request may say, and what an answer shows.
 *
 * The site only validates and records; the VPS worker (lib/api/payoutWorker.js)
 * resolves the recipient and moves the money. So a valid request always gets
 * the same `accepted` answer, whoever the recipient is.
 *
 * A username or a 0x address is paid directly. A username's existence is
 * already public (flizy.app/u/<name> answers 404 for a name that is not
 * taken), so a payout to one that is not payable failing says nothing new. A
 * phone, an email or a Telegram, Discord or GitHub id always becomes an escrow
 * claim, member or not, so those never reveal membership; the claim link comes
 * back on the payout for the platform to deliver.
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
/** E.164 after spaces, dashes, dots and brackets are dropped. */
const PHONE_RE = /^\+[1-9][0-9]{6,14}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
/** Platform ids are the numeric user id, never a handle (lib/claimRecipient.js platformRecipient). */
const PLATFORM_ID_RE = /^[0-9]{1,30}$/;
const REFERENCE_MAX = 120;
const METADATA_MAX_BYTES = 2048;

/** Recipient types paid as an escrow claim. Same list as lib/api/payoutWorker.js CLAIM_KINDS. */
export const CLAIM_TYPES = ['phone', 'email', 'telegram', 'discord', 'github'] as const;
type ClaimType = (typeof CLAIM_TYPES)[number];
type RecipientType = 'username' | 'address' | ClaimType;

type PayoutRequest = {
  symbol: PayoutSymbol;
  amount: bigint;
  recipient: { type: RecipientType; value: string };
  reference: string | null;
  metadata: Record<string, unknown> | null;
  claimExpiryDays: number | null;
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
  if (type === 'phone') {
    const phone = value.replace(/[\s().-]/g, '');
    if (!PHONE_RE.test(phone)) throw new PayoutRequestError('invalid_recipient', 'recipient.value must be a phone number in international format, e.g. +2348012345678.');
    return { type, value: phone };
  }
  if (type === 'email') {
    const email = value.toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) throw new PayoutRequestError('invalid_recipient', 'recipient.value is not a valid email address.');
    return { type, value: email };
  }
  if (type === 'telegram' || type === 'discord' || type === 'github') {
    if (!PLATFORM_ID_RE.test(value)) {
      throw new PayoutRequestError('invalid_recipient', `recipient.value must be the numeric ${type} user id, not a handle.`);
    }
    return { type, value };
  }
  throw new PayoutRequestError('invalid_recipient', 'recipient.type must be username, address, phone, email, telegram, discord or github.');
}

/** The whole request body, validated, or a PayoutRequestError. Unknown fields are refused. */
export function parsePayoutRequest(body: unknown): PayoutRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PayoutRequestError('invalid_request', 'The body must be a JSON object.');
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !['amount', 'asset', 'recipient', 'reference', 'metadata', 'claim_expiry_days'].includes(k));
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
  // How long a claim stays claimable. The platform's own maximum is checked by
  // the route, which has the platform; this is only the shape.
  let claimExpiryDays: number | null = null;
  if (b.claim_expiry_days != null) {
    if (!(CLAIM_TYPES as readonly string[]).includes(recipient.type)) {
      throw new PayoutRequestError('invalid_claim_expiry', 'claim_expiry_days applies only to phone, email and platform id recipients.');
    }
    if (!Number.isInteger(b.claim_expiry_days) || (b.claim_expiry_days as number) < 1 || (b.claim_expiry_days as number) > 365) {
      throw new PayoutRequestError('invalid_claim_expiry', 'claim_expiry_days must be a whole number of days from 1.');
    }
    claimExpiryDays = b.claim_expiry_days as number;
  }
  return { symbol, amount, recipient, reference, metadata, claimExpiryDays };
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
  claim_url: string | null;
  claim_expires_at: string | null;
  refund_tx_hash: string | null;
  cancel_requested_at: string | null;
  created_at: string;
  updated_at: string;
};

export const PAYOUT_COLUMNS =
  'id, state, amount, asset, recipient_kind, recipient_ref, reference, metadata, tx_hash, error_code, claim_url, claim_expires_at, refund_tx_hash, cancel_requested_at, created_at, updated_at';

/** "10.5" for 10.5, "20" for 20.0: formatUnits always keeps a decimal point. */
export function plainAmount(units: bigint, decimals: number): string {
  const s = formatUnits(units, decimals);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * What the API shows for one payout. `completed` is true only once the money
 * reached its destination (confirmed) or came back (refunded). A claim payout
 * also shows its link, for the platform to deliver to its user, and when it
 * expires; the link appears once the hold is confirmed (claim_pending).
 */
export function payoutView(row: PayoutRow) {
  const asset = PAYOUT_ASSETS[row.asset as PayoutSymbol];
  const isClaim = (CLAIM_TYPES as readonly string[]).includes(row.recipient_kind);
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
    claim: isClaim
      ? {
          url: row.claim_url,
          expires_at: row.claim_expires_at,
          cancel_requested: Boolean(row.cancel_requested_at),
          refund_tx_hash: row.refund_tx_hash,
        }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
