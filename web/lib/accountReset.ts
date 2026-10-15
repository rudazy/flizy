/**
 * Hand an account to whoever just proved its inbox at a re-signup.
 *
 * An account whose email was never verified may have been set up by someone
 * who does not own that address: earlier flows signed people in before the
 * email was proven. When the inbox owner signs up again and enters the code
 * (POST /api/auth/signup/verify), they get the account, but they must not
 * inherit what the earlier holder controls. So, at that moment:
 *
 *   - the password becomes the one chosen at the re-signup;
 *   - the unlock PIN is cleared, so a PIN the earlier holder knows opens
 *     nothing;
 *   - every linked chat (WhatsApp, Telegram) and platform (GitHub, Discord, X)
 *     is unlinked, each logged to identity_events, and the chat unlock
 *     sessions go with them;
 *   - the trusted list is emptied, including addresses still in their 24 hour
 *     hold and adds started from chat, so the new owner does not inherit
 *     destinations someone else chose.
 *
 * The caller signs out every web session and mails the address. Only a
 * re-signup reaches this: a first signup has nothing to reset.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit extension: this module is also loaded straight by node --test.
import { unlinkChannelIdentity } from './channelBind.ts';

/** Every channel an identity can be linked on. */
export const RESET_CHANNELS = ['whatsapp', 'telegram', 'github', 'discord', 'x'] as const;

export type ResetResult = { unlinked: string[]; trustedRemoved: number };

/**
 * Throws if any step fails: the caller must not sign anyone in on an account
 * that still carries part of the earlier holder's setup. Every step is safe
 * to run again, so a retry finishes the job.
 */
export async function resetForNewOwner(
  supabase: SupabaseClient,
  accountId: string,
  passwordHash: string
): Promise<ResetResult> {
  const { error } = await supabase
    .from('accounts')
    .update({ password_hash: passwordHash, unlock_pin_hash: null })
    .eq('id', accountId);
  if (error) throw new Error(`account reset failed: ${error.message}`);

  const unlinked: string[] = [];
  for (const channel of RESET_CHANNELS) {
    const res = await unlinkChannelIdentity(supabase, { accountId, channel });
    if (res.removed) unlinked.push(channel);
  }

  // The unlock state belonged to chats that are no longer linked.
  const { error: sErr } = await supabase.from('sessions').delete().eq('account_id', accountId);
  if (sErr) throw new Error(`chat session reset failed: ${sErr.message}`);

  const { data: trusted, error: tErr } = await supabase
    .from('trusted_addresses')
    .delete()
    .eq('account_id', accountId)
    .select('id');
  if (tErr) throw new Error(`trusted list reset failed: ${tErr.message}`);
  const { error: kErr } = await supabase.from('trusted_add_tickets').delete().eq('account_id', accountId);
  if (kErr) throw new Error(`trusted add ticket reset failed: ${kErr.message}`);

  return { unlinked, trustedRemoved: (trusted || []).length };
}
