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

/** Official GIWA testnet faucet. Paste your Flizy agent wallet address there. */
export const GIWA_FAUCET_URL = 'https://faucet.giwa.io';
