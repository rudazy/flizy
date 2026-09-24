import { getSupabase } from './supabase';

/**
 * The site half of a trusted-add ticket. Mirror of lib/trustedTicket.js.
 *
 * The bot mints; the site reads and, once the add has succeeded, spends. Two
 * copies exist for the reason web/lib/errorScrub.ts is a copy of the bot one:
 * the Vercel root is `web`, so `../lib` is not uploaded with the deploy.
 *
 * **A ticket is not a credential.** Reading one prefills an address into the
 * add form. The account password is still required to complete the add, on the
 * same route and the same gate as any other add, so a leaked code buys nothing.
 * It is also bound to `account_id`, so it cannot prefill a different account's
 * form even if someone holds both the code and that other session.
 */

export function normalizeTicketCode(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export type TicketRead =
  | { ok: true; address: string; label: string }
  | { ok: false; reason: 'invalid' | 'used' | 'expired' };

/**
 * Look up a ticket for the account redeeming it. Does not consume it and does
 * not write anything to the trusted list.
 */
export async function readTrustedAddTicket(
  accountId: string,
  codeRaw: unknown
): Promise<TicketRead> {
  const code = normalizeTicketCode(codeRaw);
  if (!code) return { ok: false, reason: 'invalid' };

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_add_tickets')
    .select('address, label, expires_at, used_at')
    .eq('account_id', accountId)
    .eq('code', code)
    .maybeSingle();
  if (error) throw new Error(`trusted ticket read failed: ${error.message}`);

  if (!data) return { ok: false, reason: 'invalid' };
  if (data.used_at) return { ok: false, reason: 'used' };
  if (new Date(data.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true, address: String(data.address), label: String(data.label || '') };
}

/**
 * Mark a ticket spent. Called after the add succeeded, never before: a failed
 * write must not cost the person their ticket and send them back to chat.
 */
export async function consumeTrustedAddTicket(
  accountId: string,
  codeRaw: unknown
): Promise<void> {
  const code = normalizeTicketCode(codeRaw);
  if (!code) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from('trusted_add_tickets')
    .update({ used_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('code', code)
    .is('used_at', null);
  if (error) throw new Error(`trusted ticket consume failed: ${error.message}`);
}
