const { getSupabase } = require('./supabase');
const { config } = require('./config');
const { verifyPin, verifyPassword } = require('./cryptoPin');

/**
 * @param {string} accountId
 * @param {string} waSenderId
 */
async function getSession(accountId, waSenderId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('account_id', accountId)
    .eq('wa_sender_id', waSenderId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Default is unlocked (no session row).
 * Locked when is_locked=true, or unlock TTL expired after a prior unlock.
 *
 * @param {string} accountId
 * @param {string} waSenderId
 */
async function isSessionUnlocked(accountId, waSenderId) {
  const session = await getSession(accountId, waSenderId);
  if (!session) return true;
  if (session.is_locked) return false;
  if (new Date(session.expires_at).getTime() < Date.now()) return false;
  return true;
}

/**
 * True only after explicit `flizy lock` (is_locked).
 * No session row = never locked = open. Unlock clears is_locked.
 */
async function isSessionHardLocked(accountId, waSenderId) {
  const session = await getSession(accountId, waSenderId);
  if (!session) return false;
  return Boolean(session.is_locked);
}

/**
 * Touch last_active and extend expiry (session must already be unlocked).
 */
async function touchSession(accountId, waSenderId) {
  const supabase = getSupabase();
  const expires = new Date(Date.now() + config.sessionTtlMs).toISOString();
  const now = new Date().toISOString();
  const { error } = await supabase.from('sessions').upsert(
    {
      account_id: accountId,
      wa_sender_id: waSenderId,
      last_active_at: now,
      expires_at: expires,
      unlocked_at: now,
      is_locked: false,
    },
    { onConflict: 'account_id,wa_sender_id' }
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
 * Always re-reads hashes from DB so WA path matches site login.
 *
 * @param {object} account accounts row (needs id at minimum)
 * @param {string} waSenderId
 * @param {string} secret PIN or password
 */
async function unlockWithPin(account, waSenderId, secret) {
  const pin = String(secret || '');
  // Do not trim interior spaces; only strip accidental WA leading/trailing whitespace
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
  // Prefer password match first when secret is long (unlikely to be a short PIN)
  // Still try both — order: PIN if short digits, else password first then PIN.
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
      `[unlock] bad secret account=${account.id} hasPin=${hasPin} hasPassword=${hasPassword} len=${secretTrimmed.length}`
    );
    return { ok: false, reason: 'bad_pin', hasPin, hasPassword };
  }

  await touchSession(account.id, waSenderId);
  return { ok: true };
}

/**
 * Lock without password. Blocks bot commands until unlock.
 * Never sets unlocked_at to null — column is NOT NULL in DB.
 */
async function lockSession(accountId, waSenderId) {
  if (!accountId) throw new Error('lockSession: missing accountId');
  if (!waSenderId) throw new Error('lockSession: missing waSenderId');

  const supabase = getSupabase();
  const now = new Date().toISOString();
  const row = {
    account_id: accountId,
    wa_sender_id: waSenderId,
    last_active_at: now,
    // Expire immediately so soft-unlock TTL cannot re-open the session
    expires_at: now,
    is_locked: true,
  };

  const { error } = await supabase.from('sessions').upsert(row, {
    onConflict: 'account_id,wa_sender_id',
  });

  if (error) {
    // Migration not applied yet: retry without is_locked (still expire session)
    if (/is_locked|column/i.test(error.message || '')) {
      const { error: e2 } = await supabase.from('sessions').upsert(
        {
          account_id: accountId,
          wa_sender_id: waSenderId,
          last_active_at: now,
          expires_at: now,
        },
        { onConflict: 'account_id,wa_sender_id' }
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
