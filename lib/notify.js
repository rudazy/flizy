/**
 * Cross-channel outbound notifications.
 *
 * An account can be reached on every channel it has linked. A client process
 * registers the channels it can deliver on; anything else is queued in the
 * notifications outbox and drained by the process that owns that channel.
 *
 * Telegram delivery is a stateless HTTPS call, so the Telegram sender can be
 * registered in any process. WhatsApp needs the live web session, so only the
 * WhatsApp process registers it.
 */

const { getSupabase } = require('./supabase');
const { publicErrorMessage } = require('./sanitize');
const {
  normalizeChannel,
  assertChannel,
  listIdentitiesForAccount,
  findAccountIdByPhone,
} = require('./identity');

/** @type {Map<string, (externalId: string, body: string) => Promise<any>>} */
const senders = new Map();

/**
 * @param {string} channel
 * @param {(externalId: string, body: string) => Promise<any>} sendFn
 */
function registerChannelSender(channel, sendFn) {
  // Startup wiring done by our own client processes. An unknown channel here is
  // a bug that would park the sender under a key nothing ever looks up, so it
  // fails at boot rather than going quietly undeliverable at runtime.
  senders.set(assertChannel(channel, 'registerChannelSender'), sendFn);
}

function canSendDirect(channel) {
  return senders.has(normalizeChannel(channel));
}

async function enqueue({ accountId, channel, externalId, body }) {
  const supabase = getSupabase();
  const { error } = await supabase.from('notifications').insert({
    account_id: accountId || null,
    channel: assertChannel(channel, 'notify.enqueue'),
    external_id: String(externalId),
    body: String(body),
  });
  if (error) throw new Error(error.message);
}

/**
 * Deliver to one identity: inline when this process owns the channel, queued
 * otherwise. Never throws — a notification must not break the action that
 * triggered it.
 *
 * @returns {Promise<'sent'|'queued'|'failed'>}
 */
async function deliver({ accountId, channel, externalId, body }) {
  const ch = normalizeChannel(channel);
  // Refuse rather than fall back to a default channel. External ids are numeric
  // on every channel, so delivering an unknown channel's id as WhatsApp could
  // put one person's notification in another person's chat.
  if (!ch) {
    console.warn(`[notify] unknown channel ${JSON.stringify(String(channel || ''))}, not delivered`);
    return 'failed';
  }
  const sender = senders.get(ch);

  if (sender) {
    try {
      await sender(String(externalId), String(body));
      return 'sent';
    } catch (err) {
      console.warn(`[notify] direct ${ch} failed:`, publicErrorMessage(err));
    }
  }

  try {
    await enqueue({ accountId, channel: ch, externalId, body });
    return 'queued';
  } catch (err) {
    console.warn(`[notify] queue ${ch} failed:`, publicErrorMessage(err));
    return 'failed';
  }
}

/**
 * Notify an account on every channel it has linked.
 *
 * @param {string} accountId
 * @param {string} body
 * @param {{ skip?: Array<{ channel: string, externalId: string }> }} [opts]
 * @returns {Promise<{ delivered: number, queued: number }>}
 */
async function notifyAccount(accountId, body, opts = {}) {
  const result = { delivered: 0, queued: 0 };
  if (!accountId || !body) return result;

  let identities = [];
  try {
    identities = await listIdentitiesForAccount(accountId);
  } catch (err) {
    console.warn('[notify] identity list failed:', publicErrorMessage(err));
    return result;
  }

  // Unknown channels are dropped from the skip list rather than keyed as null,
  // which would make two different unknown channels compare equal and silently
  // suppress a notification that should have gone out.
  const skip = (opts.skip || [])
    .filter((s) => normalizeChannel(s.channel))
    .map((s) => `${normalizeChannel(s.channel)}:${String(s.externalId)}`);

  for (const identity of identities) {
    const ch = normalizeChannel(identity.channel);
    if (!ch) {
      console.warn(
        `[notify] account ${accountId} has an identity on unknown channel ${JSON.stringify(String(identity.channel || ''))}, skipped`
      );
      continue;
    }
    const key = `${ch}:${identity.external_id}`;
    if (skip.includes(key)) continue;

    const outcome = await deliver({
      accountId,
      channel: ch,
      externalId: identity.external_id,
      body,
    });
    if (outcome === 'sent') result.delivered += 1;
    if (outcome === 'queued') result.queued += 1;
  }

  return result;
}

/**
 * Notify whoever owns this phone, if it belongs to a Flizy account.
 * Unknown numbers are never cold-messaged: the caller shares a claim link instead.
 *
 * @param {string} phone
 * @param {string} body
 * @param {{ skip?: Array<{ channel: string, externalId: string }> }} [opts]
 * @returns {Promise<{ known: boolean, accountId: string|null, delivered: number, queued: number }>}
 */
async function notifyPhone(phone, body, opts = {}) {
  let accountId = null;
  try {
    accountId = await findAccountIdByPhone(phone);
  } catch (err) {
    console.warn('[notify] phone lookup failed:', publicErrorMessage(err));
  }
  if (!accountId) {
    return { known: false, accountId: null, delivered: 0, queued: 0 };
  }
  const res = await notifyAccount(accountId, body, opts);
  return { known: true, accountId, ...res };
}

/**
 * Drain queued messages for the channel this process owns.
 * @param {string} channel
 * @param {number} [limit]
 */
async function drainOutbox(channel, limit = 20) {
  const ch = normalizeChannel(channel);
  const sender = senders.get(ch);
  if (!sender) return { sent: 0, failed: 0 };

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('notifications')
    .select('id, external_id, body, attempts')
    .eq('channel', ch)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.warn('[notify] outbox read failed:', error.message);
    return { sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;
  const rows = data || [];
  if (rows.length) {
    console.log(`[notify] draining ${rows.length} pending ${ch} notification(s)`);
  }

  for (const row of rows) {
    try {
      await sender(row.external_id, row.body);
      await supabase
        .from('notifications')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', row.id);
      sent += 1;
    } catch (err) {
      const attempts = Number(row.attempts || 0) + 1;
      const reason = publicErrorMessage(err);
      await supabase
        .from('notifications')
        .update({
          attempts,
          error: reason,
          // Give up after 5 tries so a dead chat cannot loop forever
          status: attempts >= 5 ? 'failed' : 'pending',
        })
        .eq('id', row.id);
      failed += 1;
      console.warn(
        `[notify] outbox ${ch} id=${row.id} attempt=${attempts}: ${reason}`
      );
    }
  }

  return { sent, failed };
}

/**
 * Poll the outbox for this process's channel.
 * @param {string} channel
 * @param {number} [intervalMs]
 * @returns {() => void} stop function
 */
function startOutboxDrain(channel, intervalMs = 15000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await drainOutbox(channel);
    } catch (err) {
      console.warn('[notify] drain failed:', publicErrorMessage(err));
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  registerChannelSender,
  canSendDirect,
  notifyAccount,
  notifyPhone,
  deliver,
  drainOutbox,
  startOutboxDrain,
};
