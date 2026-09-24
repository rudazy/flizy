import { getSupabase } from './supabase';

/**
 * Queue a message on every chat channel an account has linked.
 *
 * Writes to the `notifications` outbox and stops. The bots drain it
 * (`lib/notify.js` `drainOutbox`), so the site never talks to WhatsApp or
 * Telegram directly and a queued message survives a bot restart.
 *
 * Extracted from claimPayout.ts, which had the only copy. A second trusted
 * destination is exactly the kind of event that tempts a second notify path,
 * and two paths means one of them eventually stops being maintained. This is
 * the one.
 *
 * Never throws. A notification that fails to queue must not roll back the thing
 * it was announcing: an unsent warning about a saved destination is bad, an
 * exception that undoes a save the user just authorised with their password is
 * worse. Failures are logged per channel and the rest still go.
 *
 * @returns how many channels were queued
 */
export async function notifyAllChannels(accountId: string, body: string): Promise<number> {
  if (!accountId || !body) return 0;
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
