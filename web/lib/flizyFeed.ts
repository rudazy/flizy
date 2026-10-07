/**
 * The public shape of one Flizy move, for Scan.
 *
 * History is one account. This is every account, and the only fields that
 * leave the server are the ones the ledger draws. A payment shows its rail
 * (GitHub pay, Telegram pay, Phone pay, Email pay, Flizy pay), never the
 * recipient's handle, saved name or display name. A Flizy @username shows
 * only while that account keeps "Show username on Scan" on; the route passes
 * null for an account that turned it off, and the row then shows the rail and
 * the short wallet address instead. The sender's note stays in their own
 * History. A phone key, an email, an account id, and a claim recipient hint
 * are read at most to choose a rail name, then dropped.
 */

import { shortAddr, type ActivityItem } from './dashboardTypes.ts';
import { channelLabel, historyCategory } from './historyRow.ts';
import { displaySafeLabel } from './sanitize.ts';
import { validateUsername } from './username.ts';

/** Newest rows kept. A figure on Scan is not a lifetime total. */
export const FEED_LIMIT = 100;

const LABEL_MAX = 160;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type TransferScanRow = {
  id?: string | number | null;
  amount_eth?: string | number | null;
  to_address?: string | null;
  status?: string | null;
  tx_hash?: string | null;
  created_at?: string | null;
  phone?: string | null;
  kind?: string | null;
  asset?: string | null;
  counterparty_label?: string | null;
  amount_secondary?: string | null;
  asset_secondary?: string | null;
};

export type ClaimScanRow = {
  id?: string | number | null;
  to_channel?: string | null;
  to_wa_hint?: string | null;
  to_email?: string | null;
  amount_eth?: string | number | null;
  asset?: string | null;
  status?: string | null;
  hold_tx_hash?: string | null;
  refund_tx_hash?: string | null;
  claim_tx_hash?: string | null;
  created_at?: string | null;
  claimed_at?: string | null;
};

/** @username when it is a real Flizy username. Anything else is omitted. */
export function publicActor(username: unknown): string | null {
  const parsed = validateUsername(username);
  return parsed.ok ? `@${parsed.username}` : null;
}

export type ScanFocus =
  | { kind: 'username'; username: string }
  | { kind: 'address'; address: string };

/**
 * A whole Flizy username, with or without @, or a whole 0x address.
 * A fragment, a token symbol, or a short address is not a focus: the desk
 * stays on every account until the query names one.
 */
export function parseScanFocus(query: unknown): ScanFocus | null {
  const raw = String(query || '').trim();
  if (!raw) return null;
  if (/^0x[0-9a-fA-F]{40}$/i.test(raw)) return { kind: 'address', address: raw.toLowerCase() };
  const parsed = validateUsername(raw);
  return parsed.ok ? { kind: 'username', username: parsed.username } : null;
}

function hashOrNull(value: unknown): string | null {
  const hash = typeof value === 'string' ? value.trim() : '';
  return HASH.test(hash) ? hash : null;
}

/** A chain address. A phone stuffed into the same column is not one. */
function publicAddress(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return ADDRESS.test(text) ? text : '';
}

function isWholePhone(value: string): boolean {
  const compact = value.replace(/[\s().-]/g, '');
  return /^\+?\d{10,15}$/.test(compact);
}

function isWholeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Text safe to show on the shared desk, used only for marketplace and mint
 * labels (collection and token names). A phone or an email is removed.
 * Control characters are flattened so a label cannot add a line.
 */
function publicText(value: unknown, max: number): string | null {
  const raw = String(value ?? '').trim();
  if (!raw || isWholePhone(raw) || isWholeEmail(raw)) return null;
  // Built per call. A shared global expression keeps lastIndex and can skip
  // the next phone or email.
  const stripped = raw
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, ' ')
    .replace(/\+\d[\d\s().-]{6,}\d/g, ' ');
  const safe = displaySafeLabel(stripped, max);
  return safe || null;
}

/** Rail name only. The handle, phone or email that proved the rail is not part of the name. */
export function claimRail(row: ClaimScanRow): string {
  const channel = String(row.to_channel || '').trim().toLowerCase();
  if (channel === 'github') return 'GitHub pay';
  if (channel === 'x') return 'X pay';
  if (channel === 'discord') return 'Discord pay';
  if (channel === 'telegram') return 'Telegram pay';
  if (channel === 'whatsapp') return 'WhatsApp pay';
  if (row.to_email) return 'Email pay';
  if (row.to_wa_hint) return 'Phone pay';
  return 'Claim';
}

function claimHash(row: ClaimScanRow): string | null {
  const status = String(row.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'canceled') {
    return hashOrNull(row.refund_tx_hash) || hashOrNull(row.hold_tx_hash);
  }
  if (status === 'claimed') return hashOrNull(row.claim_tx_hash) || hashOrNull(row.hold_tx_hash);
  return hashOrNull(row.hold_tx_hash);
}

export const FLIZY_PAY = 'Flizy pay';

/**
 * The label a payment to a Flizy account was logged with: its username
 * ("@name") or the web pay page ("flizy pay"). Used only when the route could
 * not match the address to an account; such a row names no one.
 */
function isFlizyPayLabel(label: unknown): boolean {
  const text = String(label || '').trim();
  return text.toLowerCase() === 'flizy pay' || (text.startsWith('@') && validateUsername(text).ok);
}

/**
 * The Flizy account a transfer went to, as Scan may show it: its username, or
 * null when that account hides it (or none could be read).
 */
export type ScanRecipient = { username: string | null };

/**
 * One transfer, from the account that made it. One payment stays one row.
 * `username` is the sender's, null when hidden. `recipient` is set when the
 * money went to a Flizy account.
 */
export function scanTransferItem(row: TransferScanRow, username: unknown, recipient: ScanRecipient | null = null): ActivityItem {
  const kind = String(row.kind || 'transfer').toLowerCase();
  const asset = String(row.asset || 'ETH').toUpperCase();
  const amount = row.amount_eth ?? '0';
  const to = publicAddress(row.to_address);
  // The recipient label is a saved name, a username or a display name, so it
  // is read only on marketplace rows, where it names a collection or token.
  const marketLabel = kind === 'nft_market' ? publicText(row.counterparty_label, LABEL_MAX) : null;
  const outAmt = row.amount_secondary ? String(row.amount_secondary) : null;
  const outAsset = row.asset_secondary ? String(row.asset_secondary) : null;

  let type: ActivityItem['type'] = 'transfer';
  if (kind === 'swap') type = 'swap';
  else if (kind === 'withdraw' || kind === 'withdraw_token') type = 'withdraw';

  const actor = publicActor(username);
  const flizy = type === 'transfer' && kind !== 'nft_market' ? recipient ?? (isFlizyPayLabel(row.counterparty_label) ? { username: null } : null) : null;
  const payee = flizy ? publicActor(flizy.username) : null;
  const dest = payee || (to ? shortAddr(to) : '');

  let label = '';
  if (type === 'swap') {
    label = outAmt && outAsset ? `${amount} ${asset} → ${outAmt} ${outAsset}` : `Swap ${amount} ${asset}`;
  } else if (kind === 'nft_market') {
    label = marketLabel || 'NFT marketplace';
  } else {
    const sent = dest ? `Sent ${amount} ${asset} → ${dest}` : `Sent ${amount} ${asset}`;
    // With the sender named, the rail is its own line; without, it leads.
    label = flizy && !actor ? `${FLIZY_PAY} · ${sent}` : sent;
  }

  return {
    id: String(row.id ?? ''),
    type,
    direction: 'out',
    amount,
    asset,
    amountSecondary: outAmt,
    assetSecondary: outAsset,
    counterparty: payee || to || null,
    status: String(row.status || 'unknown'),
    txHash: hashOrNull(row.tx_hash),
    createdAt: String(row.created_at || ''),
    note: null,
    label,
    category: historyCategory(type, kind),
    channel: channelLabel(row.phone),
    actor,
    rail: flizy ? FLIZY_PAY : null,
  };
}

/** One claim: the rail only, never the recipient's handle, phone, email, or external id. */
export function scanClaimItem(row: ClaimScanRow, username: unknown): ActivityItem {
  const status = String(row.status || 'pending');
  const amount = row.amount_eth ?? '0';
  const asset = String(row.asset || 'ETH').toUpperCase();
  const rail = claimRail(row);
  const word =
    status === 'claimed' ? 'claimed' : status === 'cancelled' || status === 'canceled' ? 'cancelled' : status === 'processing' ? 'processing' : 'held';

  return {
    id: `claim_${String(row.id ?? '')}`,
    type: 'claim',
    direction: 'out',
    amount,
    asset,
    counterparty: null,
    status,
    txHash: claimHash(row),
    createdAt: String(row.claimed_at || row.created_at || ''),
    note: null,
    label: `${rail} · ${word} · ${amount} ${asset}`,
    category: 'claim',
    actor: publicActor(username),
    rail,
  };
}

/** Newest first, capped. Undated rows sort last. */
export function mergeFeed(items: ActivityItem[], limit = FEED_LIMIT): ActivityItem[] {
  return [...items]
    .sort((a, b) => {
      const at = Date.parse(a.createdAt);
      const bt = Date.parse(b.createdAt);
      const an = Number.isFinite(at) ? at : 0;
      const bn = Number.isFinite(bt) ? bt : 0;
      return bn - an;
    })
    .slice(0, limit);
}
