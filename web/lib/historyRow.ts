/**
 * History rows: which filter a row belongs under, and which channel a payment
 * went through. Pure, so test/historyRow.test.js loads it directly.
 *
 * The channel comes from transfers.phone, which is the identity key of the
 * account that made the payment: 'site' for the web app, 'telegram:<id>',
 * 'discord:<id>' and so on for platforms, bare digits for WhatsApp
 * (lib/channelKey.js identityTransferKey). Only the channel name ever leaves
 * the server; the key itself can be a phone number.
 */

export type HistoryCategory = 'send' | 'receive' | 'swap' | 'claim' | 'nft';

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
