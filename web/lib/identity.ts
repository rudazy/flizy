import { getSiteConfig, getSupabase } from './supabase';
import { generateLinkCode } from './linkCode';

/**
 * One-time link code for binding a chat identity to this account.
 * The same code works on any channel: only a logged-in account holder can make one.
 */
export async function createLinkCode(accountId: string) {
  const supabase = getSupabase();
  const { linkCodeTtlMs, botWhatsAppNumber, telegramBotUsername } = getSiteConfig();
  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + linkCodeTtlMs).toISOString();

  const { error } = await supabase.from('link_codes').insert({
    account_id: accountId,
    code,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);

  const prefill = encodeURIComponent(`flizy link ${code}`);
  const waDeepLink = botWhatsAppNumber
    ? `https://wa.me/${botWhatsAppNumber}?text=${prefill}`
    : `https://wa.me/?text=${prefill}`;

  const telegramDeepLink = telegramBotUsername
    ? `https://t.me/${telegramBotUsername}?start=${code}`
    : null;

  return { code, expiresAt, waDeepLink, telegramDeepLink };
}
