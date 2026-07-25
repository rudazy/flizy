/**
 * Unlock sessions, scoped per (account, channel, identity).
 *
 * Lock is per channel by design: locking Telegram must not lock the WhatsApp
 * the user still has in hand, and vice versa.
 */

const { getSupabase } = require('./supabase');
const { config } = require('./config');
const { verifyPin, verifyPassword } = require('./cryptoPin');
const { normalizeChannel, normalizeExternalId } = require('./identity');

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
    .eq('channel', normalizeChannel(channel))
    .eq('external_id', normalizeExternalId(externalId))
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Default is unlocked (no session row).
 * Locked when is_locked=true, or unlock TTL expired after a prior unlock.
 */
async function isSessionUnlocked(accountId, channel, externalId) {
  const session = await getSession(accountId, channel, externalId);
  if (!session) return true;
  if (session.is_locked) return false;
  if (new Date(session.expires_at).getTime() < Date.now()) return false;
  return true;
}

/**
 * True only after an explicit lock command.
 * No session row = never locked = open. Unlock clears is_locked.
 */
async function isSessionHardLocked(accountId, channel, externalId) {
  const session = await getSession(accountId, channel, externalId);
  if (!session) return false;
  return Boolean(session.is_locked);
}

/**
 * Touch last_active and extend expiry (session must already be unlocked).
 */
async function touchSession(accountId, channel, externalId) {
  const supabase = getSupabase();
  const expires = new Date(Date.now() + config.sessionTtlMs).toISOString();
  const now = new Date().toISOString();
  const { error } = await supabase.from('sessions').upsert(
    {
      account_id: accountId,
      channel: normalizeChannel(channel),
      external_id: normalizeExternalId(externalId),
      last_active_at: now,
      expires_at: expires,
      unlocked_at: now,
      is_locked: false,
    },
    { onConflict: CONFLICT }
  );
  if (error) throw new Error(error.message);
}

/**
 * Load password/PIN hashes from DB (join rows can be stale or partial).
 * @param {string} accountId
 */
async function loadAuthHashes(accountId) {
  if (!accountId) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .select('id, password_hash, unlock_pin_hash')
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Unlock with PIN (digits) or site account password.
 * Always re-reads hashes from DB so chat unlock matches site login.
 *
 * @param {object} account accounts row (needs id at minimum)
 * @param {string} channel
 * @param {string} externalId
 * @param {string} secret PIN or password
 */
async function unlockWithPin(account, channel, externalId, secret) {
  const pin = String(secret || '');
  // Do not trim interior spaces; only strip accidental leading/trailing whitespace
  const secretTrimmed = pin.trim();
  if (!secretTrimmed) return { ok: false, reason: 'empty' };

  if (!account?.id) {
    return { ok: false, reason: 'no_account' };
  }

  const auth = await loadAuthHashes(account.id);
  if (!auth) {
    return { ok: false, reason: 'no_account' };
  }

  const hasPin = Boolean(auth.unlock_pin_hash);
  const hasPassword = Boolean(auth.password_hash);

  let ok = false;
  // Try the likely form first, then the other: a short digit string is a PIN,
  // anything else is probably the site password.
  const looksLikePin = /^\d{4,12}$/.test(secretTrimmed);

  if (looksLikePin && hasPin && verifyPin(secretTrimmed, auth.unlock_pin_hash)) {
    ok = true;
  } else if (hasPassword && verifyPassword(secretTrimmed, auth.password_hash)) {
    ok = true;
  } else if (!looksLikePin && hasPin && verifyPin(secretTrimmed, auth.unlock_pin_hash)) {
    ok = true;
  } else if (looksLikePin && hasPassword && verifyPassword(secretTrimmed, auth.password_hash)) {
    ok = true;
  }

  if (!ok) {
    if (!hasPin && !hasPassword) {
      return { ok: false, reason: 'no_pin' };
    }
    console.warn(
      `[unlock] bad secret account=${account.id} channel=${normalizeChannel(channel)} hasPin=${hasPin} hasPassword=${hasPassword} len=${secretTrimmed.length}`
    );
    return { ok: false, reason: 'bad_pin', hasPin, hasPassword };
  }

  await touchSession(account.id, channel, externalId);
  return { ok: true };
}

/**
 * Lock without password. Blocks bot commands on this channel until unlock.
 * Never sets unlocked_at to null — column is NOT NULL in DB.
 */
async function lockSession(accountId, channel, externalId) {
  if (!accountId) throw new Error('lockSession: missing accountId');
  const ch = normalizeChannel(channel);
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

module.exports = {
  getSession,
  isSessionUnlocked,
  isSessionHardLocked,
  touchSession,
  unlockWithPin,
  lockSession,
  loadAuthHashes,
};
