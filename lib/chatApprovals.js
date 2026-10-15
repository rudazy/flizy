/**
 * One-time PIN approval links for chat.
 *
 * Flizy never takes the PIN in a chat message: a message stays in the chat
 * history, on the phone and on the chat provider's servers. When chat needs
 * the PIN (to unlock, to approve a payment, to unlink), the bot calls
 * createApproval and sends the link it returns. The PIN is typed on
 * https://flizy.app/a/<token> (web/app/api/approvals/[token]), which marks the
 * row approved. This process then picks the approval up with a short poll and
 * hands it to the handler the router registered.
 *
 * The link token is 128 random bits and only its sha256 is stored. A link
 * works once and for 5 minutes, the same lifetime as the plan it approves.
 *
 * Approvals are tracked in this process's memory because the plan they approve
 * lives here too (lib/commands/pending.js). A bot restart drops both, and the
 * link then simply expires.
 */

const crypto = require('crypto');
const { getSupabase } = require('./supabase');
const { config } = require('./config');
const { assertChannel, normalizeExternalId } = require('./channelKey');
const { publicErrorMessage } = require('./sanitize');

const TABLE = 'chat_approvals';

/** How long a link works. Matches PENDING_TTL_MS, the life of a chat plan. */
const APPROVAL_TTL_MS = 5 * 60 * 1000;

/** How often this process looks for approvals while any are open. */
const POLL_MS = 2000;

const KINDS = new Set(['unlock', 'plan', 'unlink']);

/** @type {Map<string, object>} approval id -> what the handler needs */
const tracked = new Map();

/** @type {((event: { type: 'approved'|'cancelled'|'expired', meta: object }) => Promise<void>) | null} */
let handler = null;
let timer = null;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * The chat named on the page, so a forwarded link says whose chat it is for.
 * A Telegram @handle when there is one, otherwise the last four digits of the
 * id: enough for the owner to recognise, not enough to contact.
 */
function chatLabelFor(ctx) {
  const name = ctx.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  const handle = String(ctx.displayHandle || '')
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 32);
  if (handle) return `${name} @${handle}`;
  const digits = String(ctx.externalId || '').replace(/\D/g, '');
  return digits ? `${name} ending ${digits.slice(-4)}` : name;
}

/**
 * Write an approval and start watching it.
 *
 * @param {object} p
 * @param {string} p.accountId
 * @param {object} p.ctx the chat asking (channel, externalId, key)
 * @param {'unlock'|'plan'|'unlink'} p.kind
 * @param {{ title: string, lines?: string[] }} p.summary what the page shows
 * @param {object} [p.meta] anything the handler needs back
 * @returns {Promise<{ id: string, url: string }>}
 */
async function createApproval({ accountId, ctx, kind, summary, meta = {} }) {
  if (!accountId) throw new Error('createApproval: missing accountId');
  if (!KINDS.has(kind)) throw new Error(`createApproval: unknown kind ${kind}`);
  const channel = assertChannel(ctx.channel, 'createApproval');
  const externalId = normalizeExternalId(ctx.externalId);

  const token = crypto.randomBytes(16).toString('base64url');
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const { data, error } = await getSupabase()
    .from(TABLE)
    .insert({
      token_hash: hashToken(token),
      account_id: accountId,
      channel,
      external_id: externalId,
      kind,
      summary: {
        title: String(summary?.title || ''),
        lines: (summary?.lines || []).map((l) => String(l)),
      },
      chat_label: chatLabelFor(ctx),
      expires_at: expiresAt,
    })
    .select('id')
    .single();
  if (error) throw new Error(`approval create failed: ${error.message}`);

  tracked.set(data.id, { ...meta, id: data.id, kind, accountId, channel, externalId, key: ctx.key, expiresAt });
  return { id: data.id, url: `${config.siteUrl}/a/${token}` };
}

/**
 * Withdraw an approval that has not been acted on (its plan was replaced or
 * dropped). The link then reads "This request was replaced". Never throws.
 */
async function cancelApproval(id) {
  if (!id) return;
  tracked.delete(id);
  const { error } = await getSupabase()
    .from(TABLE)
    .update({ cancelled_at: new Date().toISOString() })
    .eq('id', id)
    .is('consumed_at', null)
    .is('cancelled_at', null);
  if (error) console.warn('[approval] cancel failed:', publicErrorMessage(error));
}

function setApprovalHandler(fn) {
  handler = fn;
}

async function emit(type, meta) {
  if (!handler) return;
  try {
    await handler({ type, meta });
  } catch (err) {
    console.error(`[approval] ${type} handler failed:`, publicErrorMessage(err));
  }
}

/**
 * One pass: every approval this process is waiting on, checked once.
 * An approval is acted on only by the caller that wins the consumed_at
 * compare-and-swap, so two passes, or two processes, cannot act twice.
 */
async function pollApprovals() {
  if (!tracked.size) return;
  const ids = [...tracked.keys()];
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, approved_at, consumed_at, cancelled_at, expires_at')
    .in('id', ids);
  if (error) {
    console.warn('[approval] poll failed:', publicErrorMessage(error));
    return;
  }

  const seen = new Set();
  for (const row of data || []) {
    seen.add(row.id);
    const meta = tracked.get(row.id);
    if (!meta) continue;

    if (row.cancelled_at) {
      tracked.delete(row.id);
      await emit('cancelled', meta);
      continue;
    }
    // Already acted on (by an overlapping pass): nothing left to do, and
    // nothing to tell anyone.
    if (row.consumed_at) {
      tracked.delete(row.id);
      continue;
    }
    if (row.approved_at) {
      const { data: won, error: casError } = await supabase
        .from(TABLE)
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', row.id)
        .is('consumed_at', null)
        .is('cancelled_at', null)
        .select('id');
      tracked.delete(row.id);
      if (!casError && won && won.length) await emit('approved', meta);
      continue;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      tracked.delete(row.id);
      await emit('expired', meta);
    }
  }
  // A row that vanished counts as cancelled.
  for (const id of ids) {
    if (!seen.has(id) && tracked.has(id)) {
      const meta = tracked.get(id);
      tracked.delete(id);
      await emit('cancelled', meta);
    }
  }
}

/** Start the poll, once per process. */
function startApprovalWatcher() {
  if (timer) return;
  timer = setInterval(() => {
    pollApprovals().catch((err) => console.error('[approval] poll threw:', publicErrorMessage(err)));
  }, POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  APPROVAL_TTL_MS,
  hashToken,
  chatLabelFor,
  createApproval,
  cancelApproval,
  setApprovalHandler,
  pollApprovals,
  startApprovalWatcher,
};
