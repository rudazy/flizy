/**
 * What happened to a claim, for its sender (migration
 * 20261117140000_claim_events.sql): recorded as it happens, never edited, and
 * read back as a status and a short timeline.
 *
 * Recording never throws: a claim that was held, paid or refunded is not
 * undone because its event could not be written. Nothing personal goes in:
 * meta takes short codes only.
 *
 * Loaded by the site as well (web/app/api/history, web/app/api/claim), so it
 * requires no package.
 */

const EVENTS = Object.freeze([
  'created',
  'notified',
  'link_shared',
  'link_opened',
  'recipient_pinned',
  'claimed',
  'cancelled',
  'expired',
  'refunded',
]);

const CHANNELS = Object.freeze(['chat', 'email', 'telegram', 'whatsapp', 'discord', 'github', 'x', 'share_link']);

const CHANNEL_NAMES = Object.freeze({
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  discord: 'Discord',
  github: 'GitHub',
  x: 'X',
});

/** meta: at most five short code values, so nothing personal can be stored in it. */
function cleanMeta(meta) {
  if (meta == null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) return null;
  const out = {};
  for (const [k, v] of Object.entries(meta).slice(0, 5)) {
    if (!/^[a-z_]{1,20}$/.test(k)) continue;
    const s = String(v);
    if (/^[a-z0-9_]{1,40}$/.test(s)) out[k] = s;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Record one event. Never throws.
 * @param {object} supabase service role client
 * @param {string} claimId
 * @param {string} event one of EVENTS
 * @param {{ channel?: string|null, meta?: object|null, log?: Pick<Console, 'warn'> }} [opts]
 * @returns {Promise<'recorded'|'duplicate'|'failed'>} duplicate: a second link_opened
 */
async function recordClaimEvent(supabase, claimId, event, { channel = null, meta = null, log = console } = {}) {
  if (!claimId || !EVENTS.includes(event) || (channel != null && !CHANNELS.includes(channel))) {
    log.warn(`[claim-events] refused an event: ${String(event).slice(0, 20)}`);
    return 'failed';
  }
  try {
    const { error } = await supabase
      .from('claim_events')
      .insert({ claim_id: claimId, event, channel: channel || null, meta: cleanMeta(meta) });
    if (!error) return 'recorded';
    if (error.code === '23505') return 'duplicate';
    log.warn(`[claim-events] ${event} not recorded: ${String(error.message || '').slice(0, 120)}`);
    return 'failed';
  } catch (err) {
    log.warn(`[claim-events] ${event} not recorded: ${String((err && err.message) || err).slice(0, 120)}`);
    return 'failed';
  }
}

/**
 * The events of these claims, oldest first. Throws on a read error.
 * @param {object} supabase
 * @param {string[]} claimIds
 * @returns {Promise<Map<string, Array<{ event: string, channel: string|null, at: string }>>>}
 */
async function loadClaimEvents(supabase, claimIds) {
  const out = new Map();
  const ids = [...new Set((claimIds || []).filter(Boolean).map(String))];
  if (!ids.length) return out;
  const { data, error } = await supabase
    .from('claim_events')
    .select('claim_id, event, channel, created_at')
    .in('claim_id', ids)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    const key = String(row.claim_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ event: row.event, channel: row.channel || null, at: row.created_at });
  }
  for (const list of out.values()) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out;
}

/** One event in words, for the sender. */
function eventLabel(e) {
  const where = CHANNEL_NAMES[e.channel] || null;
  switch (e.event) {
    case 'created':
      return 'Sent';
    case 'notified':
      if (e.channel === 'email') return 'Recipient notified by email';
      return where ? `Recipient notified on ${where}` : 'Recipient notified on Flizy';
    case 'link_shared':
      return where ? `Claim link shared to ${where}` : 'Claim link shared';
    case 'link_opened':
      return 'Link opened';
    case 'recipient_pinned':
      return 'Recipient confirmed on Telegram';
    case 'claimed':
      return 'Claimed';
    case 'cancelled':
      return 'Cancelled';
    case 'expired':
      return 'Expired';
    case 'refunded':
      return 'Refunded to you';
    default:
      return null;
  }
}

/**
 * The sender's timeline: one line per event. A claim from before events has
 * none, and shows only that it was sent.
 * @returns {Array<{ label: string, at: string }>}
 */
function claimTimeline(claim, events) {
  const list = (events || []).map((e) => ({ label: eventLabel(e), at: e.at })).filter((e) => e.label);
  if (!list.length && claim && claim.created_at) return [{ label: 'Sent', at: claim.created_at }];
  return list;
}

/** The status chip: the claims table's status, with the furthest step reached while it waits. */
function claimStatusLabel(claim, events) {
  const status = String((claim && claim.status) || 'pending');
  const seen = new Set((events || []).map((e) => e.event));
  if (status === 'claimed') return 'Claimed';
  if (status === 'cancelled') return seen.has('expired') ? 'Expired' : 'Cancelled';
  if (status === 'expired') return 'Expired';
  if (status === 'processing') return 'Processing';
  if (seen.has('link_opened')) return 'Link opened';
  if (seen.has('notified')) return 'Recipient notified';
  if (seen.has('link_shared')) return 'Link shared';
  return 'Waiting';
}

/** How long ago, short: 5m, 3h, 2d. */
function claimAge(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.floor((now - t) / 60000));
  if (min < 60) return `${min}m`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / (60 * 24))}d`;
}

module.exports = {
  EVENTS,
  CHANNELS,
  recordClaimEvent,
  loadClaimEvents,
  claimTimeline,
  claimStatusLabel,
  claimAge,
};
