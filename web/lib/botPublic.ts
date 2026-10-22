/** Public bot contact helpers. Never put personal numbers in public HTML by default. */

export function getPublicBotNumber(): string {
  const raw =
    process.env.NEXT_PUBLIC_BOT_WHATSAPP_NUMBER ||
    process.env.BOT_WHATSAPP_NUMBER ||
    '';
  return String(raw).replace(/^\+/, '').replace(/\D/g, '');
}

/** Only show digits when explicitly enabled (private demos). Public deploys: false. */
export function shouldShowBotNumber(): boolean {
  return String(process.env.NEXT_PUBLIC_SHOW_BOT_NUMBER || 'false').toLowerCase() === 'true';
}

export function formatBotE164(digits?: string): string {
  const d = digits || getPublicBotNumber();
  if (!d) return '';
  return `+${d}`;
}

export function botWaMeUrl(text?: string): string {
  const d = getPublicBotNumber();
  if (!d) return '';
  if (!text) return `https://wa.me/${d}`;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/**
 * The bots' links for the public footer, read on the server. Telegram usernames
 * are public by design; the WhatsApp link carries the bot's number, so it is
 * given only where shouldShowBotNumber allows it. Null means "not available here".
 */
export function footerBotLinks(): { telegramUrl: string | null; whatsappUrl: string | null } {
  const tg = String(process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  return {
    telegramUrl: /^[A-Za-z0-9_]{5,32}$/.test(tg) ? `https://t.me/${tg}` : null,
    whatsappUrl: shouldShowBotNumber() ? botWaMeUrl() || null : null,
  };
}

/** Official GIWA testnet faucet, linked from the footer for reference. Flizy claims in one tap on Wallet, Fund. */
export const GIWA_FAUCET_URL = 'https://faucet.giwa.io';
