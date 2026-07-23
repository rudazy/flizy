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
 * Unlock with PIN (digits) or site account password.
 * @param {object} account accounts row with unlock_pin_hash and/or password_hash
 * @param {string} waSenderId
 * @param {string} secret PIN or password
 */
async function unlockWithPin(account, waSenderId, secret) {
  const pin = String(secret || '');
  if (!pin) return { ok: false, reason: 'empty' };

  let ok = false;
  if (account.unlock_pin_hash && verifyPin(pin, account.unlock_pin_hash)) {
    ok = true;
  } else if (account.password_hash && verifyPassword(pin, account.password_hash)) {
    ok = true;
  }

  if (!ok) {
    if (!account.unlock_pin_hash && !account.password_hash) {
      return { ok: false, reason: 'no_pin' };
    }
    return { ok: false, reason: 'bad_pin' };
  }

  await touchSession(account.id, waSenderId);
  return { ok: true };
}

/** Lock without password. Blocks bot commands until unlock. */
async function lockSession(accountId, waSenderId) {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const { error } = await supabase.from('sessions').upsert(
    {
      account_id: accountId,
      wa_sender_id: waSenderId,
      last_active_at: now,
      expires_at: now,
      unlocked_at: null,
      is_locked: true,
    },
    { onConflict: 'account_id,wa_sender_id' }
  );
  if (error) throw new Error(error.message);
}

module.exports = {
  getSession,
  isSessionUnlocked,
  isSessionHardLocked,
  touchSession,
  unlockWithPin,
  lockSession,
};
