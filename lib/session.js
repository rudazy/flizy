/**
 * Unlock sessions, scoped per (account, channel, identity).
 *
 * Lock is per channel by design: locking Telegram must not lock the WhatsApp
 * the user still has in hand, and vice versa.
 *
 * Chat never checks the PIN itself. The PIN is typed on a flizy.app approval
 * page (lib/chatApprovals.js); when the site approves, the bot calls
 * unlockSession. The PIN lockout lives with the PIN check on the site, one
 * counter per account (web/lib/loginAttempts.ts pinKey).
 *
 * An unlock lasts SESSION_TTL_MS without a message (30 minutes) and never more
 * than SESSION_MAX_MS after the PIN was entered (8 hours).
 */

const { getSupabase } = require('./supabase');
const { config } = require('./config');
const { assertChannel, normalizeExternalId } = require('./channelKey');

const CONFLICT = 'account_id,channel,external_id';

/**
 * @param {string} accountId
 * @param {string} channel
 * @param {string} externalId
 */
async function getSession(accountId, channel, externalId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', assertChannel(channel, 'getSession'))
    .eq('external_id', normalizeExternalId(externalId))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Unlocked only by a live unlock: a row that is not locked and has not expired.
 * No row means this chat has never unlocked, which is locked. A newly linked
 * chat starts here, so redeeming a link code does not open the wallet.
 */
async function isSessionUnlocked(accountId, channel, externalId) {
  const session = await getSession(accountId, channel, externalId);
  if (!session) return false;
  if (session.is_locked) return false;
  if (new Date(session.expires_at).getTime() < Date.now()) return false;
  return true;
}

/**
 * True only after an explicit lock command (or a password change on the site).
 * No session row is not hard-locked, so non-money commands still run; money
 * stays closed through sessionGate until the chat unlocks. Unlock clears it.
 */
async function isSessionHardLocked(accountId, channel, externalId) {
  const session = await getSession(accountId, channel, externalId);
  if (!session) return false;
  return Boolean(session.is_locked);
}

/**
 * When an unlock that started at unlockedAt should end if the chat is active
 * now: SESSION_TTL_MS from now, but never past SESSION_MAX_MS after unlock.
 */
function unlockExpiry(unlockedAt, now = Date.now()) {
  const idle = now + config.sessionTtlMs;
  const cap = new Date(unlockedAt).getTime() + config.sessionMaxMs;
  return new Date(Math.min(idle, Number.isFinite(cap) ? cap : idle)).toISOString();
}

/**
 * Open this chat, after the PIN (or a passkey) was proven on the approval
 * page. Starts the 8 hour clock.
 */
async function unlockSession(accountId, channel, externalId) {
  if (!accountId) throw new Error('unlockSession: missing accountId');
  const now = new Date();
  const { error } = await getSupabase().from('sessions').upsert(
    {
      account_id: accountId,
      channel: assertChannel(channel, 'unlockSession'),
      external_id: normalizeExternalId(externalId),
      last_active_at: now.toISOString(),
      unlocked_at: now.toISOString(),
      expires_at: unlockExpiry(now, now.getTime()),
      is_locked: false,
    },
    { onConflict: CONFLICT }
  );
  if (error) throw new Error(error.message);
}

/**
 * Keep an unlocked chat open while it is used. Moves the idle end forward but
 * never past the 8 hour cap, and never moves unlocked_at, so activity alone
 * cannot keep a chat open for ever. Only for a session that is already
 * unlocked: it never opens one.
 *
 * @param {object} session the row, as read by getSession
 */
async function touchSession(accountId, channel, externalId, session) {
  if (!session || session.is_locked) return;
  const now = Date.now();
  if (new Date(session.expires_at).getTime() <= now) return;
  const { error } = await getSupabase()
    .from('sessions')
    .update({
      last_active_at: new Date(now).toISOString(),
      expires_at: unlockExpiry(session.unlocked_at, now),
    })
    .eq('account_id', accountId)
    .eq('channel', assertChannel(channel, 'touchSession'))
    .eq('external_id', normalizeExternalId(externalId));
  if (error) throw new Error(error.message);
}

/**
 * Read whether the account has a PIN (sessionGate needs to know). Always from
 * the database: join rows can be stale or partial. Chat never compares a PIN
 * or a password itself.
 * @param {string} accountId
 */
async function loadAuthHashes(accountId) {
  if (!accountId) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .select('id, unlock_pin_hash')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Lock without password. Blocks bot commands on this channel until unlock.
 * Never sets unlocked_at to null: the column is NOT NULL in the database.
 */
async function lockSession(accountId, channel, externalId) {
  if (!accountId) throw new Error('lockSession: missing accountId');
  const ch = assertChannel(channel, 'lockSession');
  const id = normalizeExternalId(externalId);
  if (!id) throw new Error('lockSession: missing externalId');

  const supabase = getSupabase();
  const now = new Date().toISOString();
  const row = {
    account_id: accountId,
    channel: ch,
    external_id: id,
    last_active_at: now,
    // Expire immediately so soft-unlock TTL cannot re-open the session
    expires_at: now,
    is_locked: true,
  };

  const { error } = await supabase.from('sessions').upsert(row, { onConflict: CONFLICT });

  if (error) {
    // Migration not applied yet: retry without is_locked (still expire session)
    if (/is_locked|column/i.test(error.message || '')) {
      const { error: e2 } = await supabase.from('sessions').upsert(
        {
          account_id: accountId,
          channel: ch,
          external_id: id,
          last_active_at: now,
          expires_at: now,
        },
        { onConflict: CONFLICT }
      );
      if (e2) throw new Error(e2.message);
      console.warn(
        '[lock] sessions.is_locked missing — applied soft lock via expires_at only. Run migration 20260723140000_session_is_locked.sql'
      );
      return;
    }
    throw new Error(error.message);
  }
}

/**
 * Whether this actor may move money now, read from the database.
 *
 * The policies call this with who is acting, never with whether they are
 * unlocked, so an entry point cannot pass a check by claiming to be unlocked.
 *
 * A chat moves money only after an unlock with the account's PIN:
 * - no PIN on the account denies (no_pin). The PIN is set on the site,
 *   so a chat can never be the first place a credential is chosen.
 * - no session row denies (session_locked). A freshly linked chat has no row,
 *   and a link code alone must not be enough to spend.
 * A missing context or a failed read denies.
 *
 * Admins are not exempt: the same unlock applies to every account.
 *
 * @param {{ accountId?: string, channel?: string, externalId?: string }} actor
 * @param {{ requireUnlock?: boolean }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'no_context' | 'no_pin' | 'session_locked' | 'session_unavailable' }>}
 */
async function sessionGate(actor, opts = {}) {
  const requireUnlock = opts.requireUnlock ?? config.requireUnlock;
  const accountId = actor && actor.accountId;
  const externalId = actor && actor.externalId;
  let channel;
  try {
    channel = assertChannel(actor && actor.channel, 'sessionGate');
  } catch {
    return { ok: false, reason: 'no_context' };
  }
  if (!accountId || !normalizeExternalId(externalId)) return { ok: false, reason: 'no_context' };
  if (!requireUnlock) return { ok: true };

  try {
    const auth = await loadAuthHashes(accountId);
    if (!auth) return { ok: false, reason: 'no_context' };
    if (!auth.unlock_pin_hash) return { ok: false, reason: 'no_pin' };
    const unlocked = await isSessionUnlocked(accountId, channel, externalId);
    return unlocked ? { ok: true } : { ok: false, reason: 'session_locked' };
  } catch (err) {
    console.error('[session] unlock state unreadable:', err && err.message ? err.message : err);
    return { ok: false, reason: 'session_unavailable' };
  }
}

module.exports = {
  sessionGate,
  getSession,
  isSessionUnlocked,
  isSessionHardLocked,
  unlockSession,
  unlockExpiry,
  touchSession,
  lockSession,
  loadAuthHashes,
};
