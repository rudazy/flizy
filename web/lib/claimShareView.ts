import { siteOrigin } from './siteOrigin.ts';
import { claimSharePath } from './claimShare.ts';
import { claimShareMessage, telegramStartUrl } from '../../lib/claimShare.js';

/** What the sender of a claim can forward: the link, its message, and a Telegram start link for a Telegram claim. */
export type ClaimShare = { url: string; text: string; telegramUrl: string | null };

type ShareRow = {
  claim_token?: unknown;
  invite_code?: unknown;
  to_channel?: unknown;
  amount_eth?: unknown;
  asset?: unknown;
  nft_token_id?: unknown;
};

/**
 * The share for one claim, in the same words as chat (lib/claimShare.js). For
 * the claim's sender only: the link is the claim token. Null without a token.
 */
export function claimShareFor(row: ShareRow): ClaimShare | null {
  const path = claimSharePath(String(row.claim_token || ''), row.invite_code ? String(row.invite_code) : null);
  if (!path) return null;
  const url = `${siteOrigin()}${path}`;
  const telegramUrl = row.to_channel === 'telegram' ? telegramStartUrl(process.env.TELEGRAM_BOT_USERNAME, String(row.claim_token)) : null;
  const text = claimShareMessage({
    amount: String(row.amount_eth ?? ''),
    asset: String(row.asset || 'ETH'),
    nftTokenId: row.nft_token_id ? String(row.nft_token_id) : null,
    url,
    telegramUrl,
  });
  return { url, text, telegramUrl };
}
