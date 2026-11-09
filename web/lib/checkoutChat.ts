import { botWaMeUrl, shouldShowBotNumber } from './botPublic.ts';

/**
 * The chat links on a checkout page. Each opens the Flizy bot with this
 * checkout, and the bot pays it from the payer's Flizy wallet
 * (lib/api/checkoutPay.js). Telegram carries it as a start payload, co_ and the
 * id's 32 hex digits (lib/commands/parse.js checkoutFromStartPayload); WhatsApp
 * as a prefilled message. A link is null when its bot is not set up here. The
 * page is public, and the WhatsApp link carries the bot's number, so it is
 * given only where shouldShowBotNumber allows it, as in the footer.
 */
export function checkoutChatLinks(id: string): { telegram: string | null; whatsapp: string | null } {
  const hex = String(id).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return { telegram: null, whatsapp: null };
  const tg = String(process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  return {
    telegram: /^[A-Za-z0-9_]{5,32}$/.test(tg) ? `https://t.me/${tg}?start=co_${hex}` : null,
    whatsapp: shouldShowBotNumber() ? botWaMeUrl(`flizy checkout ${id.toLowerCase()}`) || null : null,
  };
}
