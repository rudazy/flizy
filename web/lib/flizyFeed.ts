/**
 * The public shape of one Flizy move, for Scan.
 *
 * History is one account. This is every account, and the only fields that
 * leave the server are the ones the ledger draws. A phone key, an email, an
 * account id, and a claim recipient hint are read at most to choose a rail
 * name, then dropped. A phone or an email written into a label or a note
 * is dropped the same way.
 */

import { shortAddr, type ActivityItem } from './dashboardTypes.ts';
import { channelLabel, historyCategory } from './historyRow.ts';
import { displaySafeLabel } from './sanitize.ts';
import { validateUsername } from './username.ts';

/** Newest rows kept. A figure on Scan is not a lifetime total. */
export const FEED_LIMIT = 100;

const NOTE_MAX = 280;
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
  note?: string | null;
};

export type ClaimScanRow = {
  id?: string | number | null;
  to_channel?: string | null;
  to_display_handle?: string | null;
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
 * Text safe to show on the shared desk.
 * A phone or an email is removed. A username, a pay code, and an ordinary
 * note stay. Control characters are flattened so a label cannot add a line.
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

function noteOrNull(value: unknown): string | null {
  return publicText(value, NOTE_MAX);
}

/** A public handle. Not an email, not a phone, not a bare numeric id. */
function publicHandle(value: unknown): string | null {
  const handle = String(value || '').trim().replace(/^@+/, '');
  if (!handle || handle.length > 39) return null;
  if (/[.@+\s]/.test(handle) || /^\d+$/.test(handle)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(handle)) return null;
  return `@${handle}`;
}

/** Rail name only. The hint that proved the rail is not part of the name. */
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

/** One transfer, from the account that made it. One payment stays one row. */
export function scanTransferItem(row: TransferScanRow, username: unknown): ActivityItem {
  const kind = String(row.kind || 'transfer').toLowerCase();
  const asset = String(row.asset || 'ETH').toUpperCase();
  const amount = row.amount_eth ?? '0';
  const to = publicAddress(row.to_address);
  const labelExtra = publicText(row.counterparty_label, LABEL_MAX) || '';
  const outAmt = row.amount_secondary ? String(row.amount_secondary) : null;
  const outAsset = row.asset_secondary ? String(row.asset_secondary) : null;

  let type: ActivityItem['type'] = 'transfer';
  if (kind === 'swap') type = 'swap';
  else if (kind === 'withdraw' || kind === 'withdraw_token') type = 'withdraw';

  let label = '';
  if (type === 'swap') {
    label = outAmt && outAsset ? `${amount} ${asset} → ${outAmt} ${outAsset}` : `Swap ${amount} ${asset}`;
  } else if (kind === 'nft_market') {
    label = labelExtra || 'NFT marketplace';
  } else {
    const dest = labelExtra || (to ? shortAddr(to) : '');
    label = dest ? `Sent ${amount} ${asset} → ${dest}` : `Sent ${amount} ${asset}`;
  }

  return {
    id: String(row.id ?? ''),
    type,
    direction: 'out',
    amount,
    asset,
    amountSecondary: outAmt,
    assetSecondary: outAsset,
    counterparty: labelExtra || to || null,
    status: String(row.status || 'unknown'),
    txHash: hashOrNull(row.tx_hash),
    createdAt: String(row.created_at || ''),
    note: noteOrNull(row.note),
    label,
    category: historyCategory(type, kind),
    channel: channelLabel(row.phone),
    actor: publicActor(username),
  };
}

/** One claim, without the recipient phone, email, or external id. */
export function scanClaimItem(row: ClaimScanRow, username: unknown): ActivityItem {
  const status = String(row.status || 'pending');
  const amount = row.amount_eth ?? '0';
  const asset = String(row.asset || 'ETH').toUpperCase();
  const rail = claimRail(row);
  const peer = publicHandle(row.to_display_handle);
  const peerBit = peer ? ` · ${peer}` : '';
  const word =
    status === 'claimed' ? 'claimed' : status === 'cancelled' || status === 'canceled' ? 'cancelled' : status === 'processing' ? 'processing' : 'held';

  return {
    id: `claim_${String(row.id ?? '')}`,
    type: 'claim',
    direction: 'out',
    amount,
    asset,
    counterparty: peer,
    status,
    txHash: claimHash(row),
    createdAt: String(row.claimed_at || row.created_at || ''),
    note: null,
    label: `${rail}${peerBit} · ${word} · ${amount} ${asset}`,
    category: 'claim',
    actor: publicActor(username),
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
