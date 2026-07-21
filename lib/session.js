const { getSupabase } = require('./supabase');
const { config } = require('./config');
const { verifyPin } = require('./cryptoPin');

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
 * @param {string} accountId
 * @param {string} waSenderId
 */
async function isSessionUnlocked(accountId, waSenderId) {
  const session = await getSession(accountId, waSenderId);
  if (!session) return false;
  if (new Date(session.expires_at).getTime() < Date.now()) return false;
  return true;
}

/**
 * Touch last_active and extend expiry.
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
    },
    { onConflict: 'account_id,wa_sender_id' }
  );
  if (error) throw new Error(error.message);
}

/**
 * @param {object} account accounts row with unlock_pin_hash
 * @param {string} waSenderId
 * @param {string} pin
 */
async function unlockWithPin(account, waSenderId, pin) {
  if (!account.unlock_pin_hash) {
    return { ok: false, reason: 'no_pin' };
  }
  if (!verifyPin(pin, account.unlock_pin_hash)) {
    return { ok: false, reason: 'bad_pin' };
  }
  await touchSession(account.id, waSenderId);
  return { ok: true };
}

async function lockSession(accountId, waSenderId) {
  const supabase = getSupabase();
  await supabase
    .from('sessions')
    .delete()
    .eq('account_id', accountId)
    .eq('wa_sender_id', waSenderId);
}

module.exports = {
  getSession,
  isSessionUnlocked,
  touchSession,
  unlockWithPin,
  lockSession,
};
