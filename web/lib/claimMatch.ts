/**
 * Pure claim match helpers (no DB / chain).
 * Shared rules with bot claimRecipient match semantics.
 */

import { channelLabel } from './claimRecipient.ts';
import { displaySafeLabel } from './sanitize.ts';
import { normalizeEmail, isValidEmail, maskEmail } from './email.ts';

export type ClaimMatchRow = {
  to_wa_hint?: string | null;
  to_channel?: string | null;
  to_external_id?: string | null;
  to_display_handle?: string | null;
  to_email?: string | null;
};

export type ClaimAccountKeys = {
  phones: string[];
  identities: Array<{ channel: string; externalId: string; displayHandle?: string | null }>;
  emails: string[];
};

const TG_PENDING_PREFIX = 'tguser:';

export function normalizePhoneDigits(raw: unknown): string {
  return String(raw || '').replace(/\D/g, '');
}

export function isPlausiblePhoneDigits(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 15;
}

function isTelegramPendingUsernameId(externalId: string): boolean {
  return String(externalId || '').toLowerCase().startsWith(TG_PENDING_PREFIX);
}

function telegramPendingUsernameFromId(externalId: string): string {
  const s = String(externalId || '');
  if (!isTelegramPendingUsernameId(s)) return '';
  return s.slice(TG_PENDING_PREFIX.length).trim().toLowerCase().replace(/^@+/, '');
}

export function claimMatchesAccountKeys(
  claim: ClaimMatchRow,
  keys: ClaimAccountKeys
): boolean {
  if (claim.to_channel && claim.to_external_id) {
    const ch = String(claim.to_channel);
    const id = String(claim.to_external_id).trim();
    if (keys.identities.some((i) => i.channel === ch && i.externalId === id)) {
      return true;
    }
    // Pending-by-@username Telegram holds
    if (ch === 'telegram' && isTelegramPendingUsernameId(id)) {
      const want = telegramPendingUsernameFromId(id);
      if (!want) return false;
      return keys.identities.some((i) => {
        if (i.channel !== 'telegram') return false;
        const h = String(i.displayHandle || '')
          .trim()
          .replace(/^@+/, '')
          .toLowerCase();
        return h === want;
      });
    }
    return false;
  }
  if (claim.to_email) {
    const email = normalizeEmail(claim.to_email);
    if (!email || !isValidEmail(email)) return false;
    return (keys.emails || []).includes(email);
  }
  const phone = normalizePhoneDigits(claim.to_wa_hint);
  if (!phone) return false;
  return keys.phones.includes(phone);
}

export function matchErrorForClaim(claim: ClaimMatchRow, keys: ClaimAccountKeys): string {
  if (claim.to_channel) {
    const where = channelLabel(claim.to_channel) || claim.to_channel;
    const hasChannel = keys.identities.some((i) => i.channel === claim.to_channel);
    if (claim.to_channel === 'telegram' && isTelegramPendingUsernameId(String(claim.to_external_id))) {
      return hasChannel
        ? 'This claim is for a different Telegram @username. Link the account that owns that handle.'
        : 'This claim is held for a Telegram @username. Open the Flizy Telegram bot, link with a site code, then claim.';
    }
    return hasChannel
      ? `This claim is for a different ${where} account.`
      : `This claim is held for a ${where} account. Link ${where} on Account → Platforms first.`;
  }
  if (claim.to_email) {
    if ((keys.emails || []).length) {
      return 'This claim is for a different email than the ones on your account.';
    }
    return 'This claim is held for an email. Log in with that registration email, or add and verify it on Account.';
  }
  if (keys.phones.length) {
    return 'This claim is for a different phone number than the ones on your account.';
  }
  return 'Link WhatsApp or Telegram with a verified phone (or the right platform/email) before claiming.';
}

export function claimViaLine(claim: ClaimMatchRow): string | null {
  if (claim.to_channel) {
    const where = channelLabel(claim.to_channel) || claim.to_channel;
    if (claim.to_display_handle) {
      return `${where} @${displaySafeLabel(claim.to_display_handle)}`;
    }
    return `${where} user`;
  }
  if (claim.to_email) {
    return `email ${maskEmail(claim.to_email)}`;
  }
  const phone = normalizePhoneDigits(claim.to_wa_hint);
  return phone ? `phone +${phone}` : 'phone';
}

export function formatClaimClaimedNotice(p: {
  amountEth: string | number;
  byLabel?: string | null;
  viaLine?: string | null;
  explorerUrl?: string | null;
}): string {
  const amount = String(p.amountEth ?? '').trim() || '?';
  const by = String(p.byLabel || '').trim() || 'someone';
  const via = String(p.viaLine || '').trim();
  const lines = ['Claim delivered on Flizy.', `${amount} ETH claimed by ${by}.`];
  if (via) lines.push(`You sent this to ${via}.`);
  lines.push('', 'Funds left escrow for their agent wallet.');
  if (p.explorerUrl) lines.push(String(p.explorerUrl));
  return lines.join('\n');
}
