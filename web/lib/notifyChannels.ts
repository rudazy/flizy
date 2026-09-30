import { getSupabase } from './supabase';

/**
 * Channels something actually drains. Mirror of DELIVERABLE_CHANNELS in
 * lib/channelKey.js; test/notifyDeliverable.test.js fails if the two drift.
 *
 * An account can link X, GitHub or Discord, and nothing sends on those. Rows
 * queued for them wait for a reader that does not exist, each one a message
 * somebody was supposed to receive and never does.
 */
const DELIVERABLE_CHANNELS = new Set(['whatsapp', 'telegram']);

/**
 * This module writes to the outbox directly, and `drainOutbox` in lib/notify.js
 * sends the stored body untouched -- only `deliver()` expands markers, and only
 * on its own path. So a `{{cmd:...}}` written here would reach the person
 * literally. Callers compose plain prose and absolute URLs instead.
 */
const COMMAND_MARKER = /\{\{cmd:/;

/**
 * Queue a message on every chat channel an account has linked.
 *
 * Writes to the `notifications` outbox and stops. The bots drain it
 * (`lib/notify.js` `drainOutbox`), so the site never talks to WhatsApp or
 * Telegram directly and a queued message survives a bot restart.
 *
 * This is the site's only notify path. A new event that needs announcing uses
 * it rather than a second path, because two paths means one of them eventually
 * stops being maintained.
 *
 * Never throws outside development (see the marker guard below). A notification
 * that fails to queue must not roll back the thing it was announcing: an unsent
 * warning about a saved destination is bad, an exception that undoes a save the
 * user just authorised with their password is worse. Failures are logged per channel and the rest still go.
 *
 * @returns how many channels were queued
 */
export async function notifyAllChannels(accountId: string, body: string): Promise<number> {
  if (!accountId || !body) return 0;

  if (COMMAND_MARKER.test(body)) {
    // Loud in development, survivable in production: a literal marker in a
    // delivered message is ugly, but losing the message is worse. This guards
    // bodies the code composes. Text from another user is stripped of braces by
    // its caller before it is put in a body, so data cannot trip it.
    const message = 'notifyAllChannels body contains a {{cmd:}} marker, which this path cannot render';
    if (process.env.NODE_ENV !== 'production') throw new Error(message);
    console.warn(`[notify] ${message}`);
  }

  const supabase = getSupabase();

  const { data: identities, error } = await supabase
    .from('channel_identities')
    .select('channel, external_id')
    .eq('account_id', accountId);

  if (error) {
    console.warn('[notify] could not read linked channels:', error.message);
    return 0;
  }

  let queued = 0;
  for (const row of identities || []) {
    if (!row.channel || !row.external_id) continue;
    if (!DELIVERABLE_CHANNELS.has(String(row.channel))) continue;
    try {
      const { error: insErr } = await supabase.from('notifications').insert({
        account_id: accountId,
        channel: row.channel,
        external_id: String(row.external_id),
        body,
      });
      if (insErr) {
        console.warn('[notify] enqueue failed:', insErr.message);
        continue;
      }
      queued += 1;
    } catch (err) {
      console.warn('[notify] enqueue threw:', err);
    }
  }
  return queued;
}
