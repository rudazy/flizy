/**
 * How a claim names its recipient, for the public claim page.
 *
 * Mirrors the display half of lib/claimRecipient.js. Only the public label
 * lives here: the matching rules decide who gets paid and stay on the server
 * side of the bot, where the money moves. Nothing here is ever a match key.
 *
 * A claim is addressed one of two ways:
 *   phone     to_wa_hint
 *   platform  to_channel + to_external_id (the immutable id, never the handle)
 */

// One copy of the sanitizer for the whole web app, mirroring lib/sanitize.js.
// It used to be inlined here, which is how it drifted from the bot in the first
// place.
import { displaySafeLabel as displaySafe } from './sanitize.ts';

const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  x: 'X',
  github: 'GitHub',
  discord: 'Discord',
};

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return '';
  return CHANNEL_LABELS[channel] || String(channel);
}

type ClaimRow = {
  to_wa_hint?: string | null;
  to_channel?: string | null;
  to_external_id?: string | null;
  to_display_handle?: string | null;
};

/**
 * Label for a page anyone holding the claim link can read.
 *
 * Phones stay masked to the last 4, as they always have. A platform handle is a
 * public identifier the sender typed on purpose, and the recipient needs it to
 * recognize the claim as theirs, so it is shown. The numeric platform id is
 * never shown: nothing on a public page needs it.
 */
export function publicRecipientLabel(claim: ClaimRow | null): string | undefined {
  if (!claim) return undefined;

  if (claim.to_channel) {
    const where = channelLabel(claim.to_channel);
    return claim.to_display_handle
      ? `@${displaySafe(claim.to_display_handle)} (${where})`
      : `a ${where} user`;
  }

  const digits = String(claim.to_wa_hint || '').replace(/\D/g, '');
  if (!digits) return undefined;
  return `...${digits.slice(-4)}`;
}
