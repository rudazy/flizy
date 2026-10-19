/**
 * Account security notices by email, and the chat lock that goes with a
 * password change.
 *
 * Chat warnings only reach chats that are already linked, and an account that
 * lives on the web has none, so the moments that hand out control of the
 * account also go to the owner's email: creating a chat link code, a chat
 * being linked or unlinked, a GitHub, Discord or X account being linked,
 * someone signing up with the owner's address, and changing the password
 * (which lists every linked chat so the owner can spot one they do not
 * recognise).
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

const PLATFORM_NAME: Record<string, string> = { github: 'GitHub', discord: 'Discord', x: 'X' };

/**
 * How a linked chat is named in an email: the Telegram @handle when there is
 * one, otherwise the last four digits of its number. Enough for the owner to
 * recognise their own chat, not enough to contact it.
 *
 * A WhatsApp chat id is often a linked id (LID), a number unrelated to the
 * phone, so a WhatsApp chat is named by its verified phone only, never its id.
 * Mirrors chatLabelFor in lib/chatApprovals.js.
 */
export function chatLabel(row: {
  channel?: string | null;
  display_handle?: string | null;
  phone_e164?: string | null;
  external_id?: string | null;
}): string {
  const handle = String(row.display_handle || '')
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9_.]/g, '')
    .slice(0, 32);
  if (handle) return `@${handle}`;
  const number = row.channel === 'whatsapp' ? row.phone_e164 : row.phone_e164 || row.external_id;
  const digits = String(number || '').replace(/\D/g, '');
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

/**
 * Sent to a verified owner when someone signs up with their address. Signup
 * answers that caller exactly as it answers a new address, so this mail is
 * the only place the attempt is visible, and only to the owner.
 */
export function signupAttemptMail(siteUrl: string, at: Date): MailBody {
  return {
    subject: 'Someone tried to sign up to Flizy with your email',
    text: [
      `Someone tried to create a Flizy account with this email on ${at.toUTCString()}.`,
      'This address already has an account, so nothing was created and nothing on your account changed.',
      '',
      `If it was you, sign in instead: ${siteUrl}/login`,
      'If it was not you, you do not need to do anything.',
    ].join('\n'),
  };
}

/**
 * Sent to the address that just verified at a re-signup and took over an
 * account it had never verified (web/lib/accountReset.ts). It explains why
 * the PIN, the links and the trusted list are gone, so the new owner is not
 * left guessing.
 */
export function accountResetMail(
  siteUrl: string,
  unlinked: string[],
  trustedRemoved: number,
  at: Date
): MailBody {
  const names = unlinked.map((c) => CHAT_NAME[c] || PLATFORM_NAME[c] || c);
  return {
    subject: 'Your Flizy account was reset when you verified your email',
    text: [
      `You verified this email for a Flizy account on ${at.toUTCString()}, with the new password you chose at signup.`,
      'The account had been created with this address but never verified, so whatever was set up on it before may not have been yours. It was reset:',
      '',
      '  - the unlock PIN was cleared',
      names.length
        ? `  - these were unlinked: ${names.join(', ')}`
        : '  - nothing was linked, so nothing was unlinked',
      trustedRemoved
        ? `  - the trusted list was emptied (${trustedRemoved} ${trustedRemoved === 1 ? 'address' : 'addresses'} removed)`
        : '  - the trusted list was already empty',
      '  - every other signed-in browser was signed out',
      '',
      'To use Flizy from chat again:',
      `1. Set a new unlock PIN: ${siteUrl}/dashboard/account`,
      `2. Link your chat apps and platforms again: ${siteUrl}/dashboard/account?s=chat`,
      `3. Add the wallets you send to back to your trusted list: ${siteUrl}/dashboard/account`,
      '',
      'If you did not sign up just now, someone has access to this inbox. Secure the email account first, then change your Flizy password.',
    ].join('\n'),
  };
}

/**
 * Sent when a GitHub, Discord or X account is linked. Claims sent to that
 * handle now reach this Flizy account, so a link the owner did not make is
 * worth knowing about at once.
 */
export function platformLinkedMail(siteUrl: string, platform: string, handle: string | null, at: Date): MailBody {
  const name = PLATFORM_NAME[platform] || platform;
  const who = handle ? ` (@${handle.replace(/^@/, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)})` : '';
  return {
    subject: `${name} was linked to your Flizy account`,
    text: [
      `${name}${who} was linked to your Flizy account on ${at.toUTCString()}.`,
      `Payments sent to that ${name} account on Flizy now reach you.`,
      '',
      'If this was not you:',
      `1. Unlink it: ${siteUrl}/dashboard/account?s=platforms`,
      `2. Change your password: ${siteUrl}/dashboard/account?s=security`,
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

/** A chat link or unlink, as identity_events recorded it. */
export type ChatEvent = { kind: 'linked' | 'unlinked'; channel: string; label: string; at: Date };

const EVENT_TYPE: Record<ChatEvent['kind'], string> = { linked: 'LINKED', unlinked: 'UNLINKED' };

/** How far back a chat event can be and still be mailed. */
export const CHAT_EVENT_WINDOW_MS = 10 * 60 * 1000;

export function chatChangeMail(siteUrl: string, event: ChatEvent, chats: LinkedChat[]): MailBody {
  const name = `${CHAT_NAME[event.channel] || event.channel} (${event.label})`;
  const list = chats.length
    ? chats.map((c) => `  - ${CHAT_NAME[c.channel] || c.channel} (${c.label})`)
    : ['  (none)'];
  const ifNotYou =
    event.kind === 'unlinked'
      ? [
          'If this was not you, someone has one of your linked chats and your PIN:',
          `1. Change your password: ${siteUrl}/dashboard/account?s=security`,
          '   This also locks every linked chat.',
          `2. Set a new PIN: ${siteUrl}/dashboard/account`,
        ]
      : [
          'If this was not you, someone has a link code for your account:',
          `1. Unlink it: ${siteUrl}/dashboard/account?s=chat`,
          `2. Change your password: ${siteUrl}/dashboard/account?s=security`,
        ];
  return {
    subject:
      event.kind === 'unlinked'
        ? 'A chat was unlinked from your Flizy account'
        : 'A chat was linked to your Flizy account',
    text: [
      event.kind === 'unlinked'
        ? `${name} was unlinked from your Flizy account on ${event.at.toUTCString()}.`
        : `${name} was linked to your Flizy account on ${event.at.toUTCString()}. It cannot move money until it is unlocked with your PIN.`,
      '',
      'Chats linked to this account now:',
      ...list,
      '',
      ...ifNotYou,
    ].join('\n'),
  };
}

/**
 * The newest chat link or unlink of this kind on the account, if it happened
 * inside CHAT_EVENT_WINDOW_MS. The site mails only what this finds, so a
 * caller can ask for a notice but cannot invent the event it describes.
 */
export async function recentChatEvent(
  supabase: SupabaseClient,
  accountId: string,
  kind: ChatEvent['kind'],
  now: Date = new Date()
): Promise<ChatEvent | null> {
  const { data, error } = await supabase
    .from('identity_events')
    .select('channel, external_id, display_handle, created_at')
    .eq('account_id', accountId)
    .eq('event_type', EVENT_TYPE[kind])
    .in('channel', CHAT_CHANNELS)
    .gte('created_at', new Date(now.getTime() - CHAT_EVENT_WINDOW_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`could not read chat events: ${error.message}`);
  if (!data) return null;
  // The event has no phone. A WhatsApp chat is named by its verified phone,
  // read from the link while it still exists; after an unlink there is none.
  let phone: string | null = null;
  if (data.channel === 'whatsapp') {
    const link = await supabase
      .from('channel_identities')
      .select('phone_e164')
      .eq('account_id', accountId)
      .eq('channel', 'whatsapp')
      .eq('external_id', String(data.external_id))
      .maybeSingle();
    phone = link.error || !link.data?.phone_e164 ? null : String(link.data.phone_e164);
  }
  return {
    kind,
    channel: String(data.channel),
    label: chatLabel({ ...data, phone_e164: phone }),
    at: new Date(String(data.created_at)),
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
