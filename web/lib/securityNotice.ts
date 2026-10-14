/**
 * Account security notices by email, and the chat lock that goes with a
 * password change.
 *
 * Chat warnings only reach chats that are already linked, and an account that
 * lives on the web has none, so the moments that hand out control of the
 * account also go to the owner's email: creating a chat link code, and
 * changing the password (which lists every linked chat so the owner can spot
 * one they do not recognise).
 *
 * Sending is best effort. A notice that fails to send is logged and never
 * undoes the action the owner just took. The mail text is built by pure
 * functions so it can be tested without a mail transport.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
// Explicit extensions: this module is also loaded straight by node --test.
import { sendMail } from './sendMail.ts';

export type LinkedChat = { channel: string; label: string; linkedAt: string | null };

type MailBody = { subject: string; text: string };

const CHAT_CHANNELS = ['whatsapp', 'telegram'];

const CHAT_NAME: Record<string, string> = { whatsapp: 'WhatsApp', telegram: 'Telegram' };

/**
 * How a linked chat is named in an email: the Telegram @handle when there is
 * one, otherwise the last four digits of its number or id. Enough for the owner
 * to recognise their own chat, not enough to contact it.
 */
export function chatLabel(row: {
  display_handle?: string | null;
  phone_e164?: string | null;
  external_id?: string | null;
}): string {
  const handle = String(row.display_handle || '')
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9_.]/g, '')
    .slice(0, 32);
  if (handle) return `@${handle}`;
  const digits = String(row.phone_e164 || row.external_id || '').replace(/\D/g, '');
  return digits ? `ending ${digits.slice(-4)}` : 'no number on file';
}

export function linkCodeMail(siteUrl: string, at: Date): MailBody {
  return {
    subject: 'A chat link code was created for your Flizy account',
    text: [
      `A code to connect a WhatsApp or Telegram chat to your Flizy account was created on ${at.toUTCString()}.`,
      '',
      'Whoever uses that code can operate your account from their chat once they unlock it with your PIN.',
      '',
      'If this was not you:',
      `1. Change your password: ${siteUrl}/dashboard/account?s=security`,
      '   This also locks every linked chat.',
      `2. Check the linked chats and unlink any you do not recognise: ${siteUrl}/dashboard/account?s=chat`,
    ].join('\n'),
  };
}

export function passwordChangedMail(
  siteUrl: string,
  chats: LinkedChat[],
  at: Date,
  chatsLocked = true
): MailBody {
  const list = chats.length
    ? chats.map((c) => `  - ${CHAT_NAME[c.channel] || c.channel} (${c.label})${c.linkedAt ? `, linked ${c.linkedAt.slice(0, 10)}` : ''}`)
    : ['  (none)'];
  return {
    subject: 'Your Flizy password was changed',
    text: [
      `The password on your Flizy account was changed on ${at.toUTCString()}.`,
      chatsLocked
        ? 'Every other web session was signed out, and every linked chat was locked until it is unlocked again with your PIN.'
        : 'Every other web session was signed out. Linked chats could not be locked automatically: lock each one ("flizy lock" on WhatsApp, "/lock" on Telegram), or unlink any you do not recognise.',
      '',
      'Chats linked to this account:',
      ...list,
      '',
      `If you do not recognise one of them, unlink it now: ${siteUrl}/dashboard/account?s=chat`,
      'If you did not change your password, someone has it. Change it again and check your PIN.',
    ].join('\n'),
  };
}

/** WhatsApp and Telegram chats linked to the account. */
export async function listLinkedChats(supabase: SupabaseClient, accountId: string): Promise<LinkedChat[]> {
  const { data, error } = await supabase
    .from('channel_identities')
    .select('channel, external_id, phone_e164, display_handle, linked_at')
    .eq('account_id', accountId)
    .in('channel', CHAT_CHANNELS);
  if (error) throw new Error(`could not list linked chats: ${error.message}`);
  return (data || []).map((row) => ({
    channel: String(row.channel),
    label: chatLabel(row),
    linkedAt: row.linked_at ? String(row.linked_at) : null,
  }));
}

/**
 * Lock every chat on the account. A chat with no session row is already locked
 * (lib/session.js sessionGate), so marking the existing rows is enough.
 */
export async function lockAllChats(supabase: SupabaseClient, accountId: string): Promise<void> {
  const { error } = await supabase
    .from('sessions')
    .update({ is_locked: true, expires_at: new Date().toISOString() })
    .eq('account_id', accountId);
  if (error) throw new Error(`could not lock chats: ${error.message}`);
}

/**
 * Send a notice to the account's primary email. Returns whether it went out.
 * Never throws: the caller's action has already happened.
 */
export async function mailOwner(
  supabase: SupabaseClient,
  accountId: string,
  mail: MailBody,
  send: typeof sendMail = sendMail
): Promise<boolean> {
  try {
    const { data } = await supabase.from('accounts').select('email').eq('id', accountId).maybeSingle();
    const to = String(data?.email || '').trim();
    if (!to) return false;
    const sent = await send({ to, subject: mail.subject, text: mail.text });
    if (!sent.ok) console.warn(`[security-notice] not sent: ${sent.code || 'error'}`);
    return sent.ok;
  } catch (err) {
    console.warn('[security-notice] not sent:', err instanceof Error ? err.message : err);
    return false;
  }
}
