/**
 * History rows: which filter a row belongs under, which channel a payment
 * went through, and the symbol an asset is drawn with. Pure, so
 * test/historyView.test.js loads it directly.
 *
 * The channel comes from transfers.phone, which is the identity key of the
 * account that made the payment: 'site' for the web app, 'telegram:<id>',
 * 'discord:<id>' and so on for platforms, bare digits for WhatsApp
 * (lib/channelKey.js identityTransferKey). Only the channel name ever leaves
 * the server; the key itself can be a phone number.
 */

import { listedByAddress, symbolLabel } from './listedTokens.ts';

export type HistoryCategory = 'send' | 'receive' | 'swap' | 'claim' | 'nft';

/**
 * The symbol to draw for a stored asset. Dashboard swaps picked by contract
 * address used to log the uppercased address as the symbol, so an address
 * here is named from the listed tokens, or shortened when it is not one.
 */
export function assetSymbol(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'ETH';
  if (/^0x[0-9a-f]{40}$/i.test(s)) {
    const listed = listedByAddress(s);
    if (listed) return listed.label || listed.symbol;
    const lower = s.toLowerCase();
    return `${lower.slice(0, 6)}…${lower.slice(-4)}`;
  }
  return symbolLabel(s.toUpperCase());
}

const PLATFORM_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  x: 'X',
  github: 'GitHub',
};

/** "Telegram", "WhatsApp", "Flizy app", or null when the key says nothing usable. */
export function channelLabel(key: unknown): string | null {
  const k = typeof key === 'string' ? key.trim().toLowerCase() : '';
  if (!k) return null;
  if (k === 'site') return 'Flizy app';
  // Paid from a wallet outside Flizy, through FlizyPaymentReceiver.
  if (k === 'external') return 'Outside wallet';
  // Signed by a connected wallet on the site, recorded for Scan (web/lib/walletScanRecord.ts).
  if (k === 'wallet') return 'Outside wallet';
  const prefix = k.match(/^([a-z]+):/);
  if (prefix) return PLATFORM_LABELS[prefix[1]] ?? null;
  // WhatsApp keys are the bare id: digits, or a LID that is digits too.
  return /^[0-9]{5,20}$/.test(k) ? 'WhatsApp' : null;
}

/**
 * The filter a row sits under. NFT marketplace and mint rows are logged as
 * kind 'nft_market'; a withdraw sends money out, so it is filed under Send.
 */
export function historyCategory(
  type: 'transfer' | 'receive' | 'claim' | 'swap' | 'withdraw',
  kind: string | null
): HistoryCategory {
  if (kind === 'nft_market') return 'nft';
  if (type === 'swap') return 'swap';
  if (type === 'claim') return 'claim';
  if (type === 'receive') return 'receive';
  return 'send';
}

/** The fields of a transfer row the site may hand to a browser. */
const PUBLIC_TRANSFER_FIELDS = [
  'id',
  'amount_eth',
  'to_address',
  'status',
  'tx_hash',
  'created_at',
  'kind',
  'asset',
] as const;

export type PublicTransferRow = { [K in (typeof PUBLIC_TRANSFER_FIELDS)[number]]?: unknown };

/**
 * A transfer row reduced to what the browser renders.
 *
 * History reads rows the reader received as well as rows they sent, and a
 * received row is the sender's: its phone column is the sender's chat identity
 * key (a phone number, WhatsApp LID or Telegram id) and its account_id is the
 * sender's account. An allowlist rather than deleting known-bad keys, so a
 * column added to the select later cannot leak by default.
 */
export function publicTransferRow(row: Record<string, unknown>): PublicTransferRow {
  const out: PublicTransferRow = {};
  for (const key of PUBLIC_TRANSFER_FIELDS) {
    if (key in row) out[key] = row[key];
  }
  return out;
}
