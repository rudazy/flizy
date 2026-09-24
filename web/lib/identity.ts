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

  // Mirror of lib/identity.js: retire this account's outstanding codes first, so
  // pressing the button twice does not leave two live credentials. Expired, not
  // deleted, so an older deep link is refused as expired rather than invalid.
  // Never fatal: failing to tidy up must not stop the owner getting a code.
  {
    const now = Date.now();
    // A second back, not this instant: the expiry check is `expires_at < now`,
    // so the current timestamp would leave the code valid for the rest of that
    // millisecond.
    const retiredAt = new Date(now - 1000).toISOString();
    const { error: retireErr } = await supabase
      .from('link_codes')
      .update({ expires_at: retiredAt })
      .eq('account_id', accountId)
      .is('used_at', null)
      .gt('expires_at', new Date(now).toISOString());
    if (retireErr) console.warn('[link] could not retire previous codes:', retireErr.message);
  }

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
