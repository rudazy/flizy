/**
 * The claim link a sender forwards, worded once for chat and the site.
 *
 * The link only opens the payment: claiming it still takes a Flizy account
 * that has proven the identity the claim was sent to. A Telegram claim also
 * gets a link that opens the Flizy bot on the payment (/start claim_<token>).
 *
 * Loaded by the site as well, so it requires nothing but other package-free
 * lib/ files.
 */

const { formatClaimAmount } = require('./claimAmount');

/** A claim token is 32 hex digits (lib/claims.js newClaimToken). */
const TOKEN = /^[0-9a-f]{32}$/;

/** The Telegram start payload for a claim, or null for anything that is not a token. */
function claimStartPayload(token) {
  const t = String(token || '').toLowerCase();
  return TOKEN.test(t) ? `claim_${t}` : null;
}

/** The claim token in a Telegram start payload, or null. */
function tokenFromStartPayload(payload) {
  const m = String(payload || '').match(/^claim_([0-9a-f]{32})$/i);
  return m ? m[1].toLowerCase() : null;
}

/** https://t.me/<bot>?start=claim_<token>, or null without a valid bot name or token. */
function telegramStartUrl(botUsername, token) {
  const bot = String(botUsername || '').trim().replace(/^@+/, '');
  const payload = claimStartPayload(token);
  if (!payload || !/^[A-Za-z0-9_]{5,32}$/.test(bot)) return null;
  return `https://t.me/${bot}?start=${payload}`;
}

/**
 * The message a sender forwards as is. Short, so it reads cleanly when
 * forwarded, and always says the money is test funds.
 * @param {{ amount: string|number, asset?: string, nftTokenId?: string|null, url: string, telegramUrl?: string|null }} p
 */
function claimShareMessage(p) {
  const what = formatClaimAmount({ amount_eth: p.amount, asset: p.asset || 'ETH', nft_token_id: p.nftTokenId || null });
  const lines = [`I sent you ${what} on Flizy (testnet). Claim it here: ${p.url}`];
  if (p.telegramUrl) lines.push(`Or open it in Telegram: ${p.telegramUrl}`);
  return lines.join('\n');
}

module.exports = { claimStartPayload, tokenFromStartPayload, telegramStartUrl, claimShareMessage };
