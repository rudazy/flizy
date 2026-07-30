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
 * Failed-PIN lockout.
 *
 * A 4 digit PIN is 10,000 guesses and the attacker this lock exists to stop is
 * the person holding the unlocked phone, so an attempt counter is the whole
 * feature. It lives on the session row rather than in process memory: one
 * account can be bound to two channels and both bot processes restart, so
 * memory would be a free reset.
 *
 * The ladder can be this steep only because there is a way back in that does
 * not involve waiting: proving the account password on the site clears it
 * (web/app/api/pin/route.ts). Keep the two in step.
 */
const PIN_FREE_ATTEMPTS = 4;

/** Lock applied on the 5th consecutive wrong secret, then the 6th, and so on. */
const PIN_LOCKOUT_LADDER_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

/**
 * Lock duration earned by the Nth consecutive wrong secret. 0 = no lock yet.
 * The top of the ladder repeats forever, which is what makes 10,000 guesses
 * hopeless: past the 9th wrong try every further guess costs a day.
 *
 * @param {number} attempts
 * @returns {number} ms
 */
function pinLockoutMsForAttempts(attempts) {
  const n = Number(attempts) || 0;
  if (n <= PIN_FREE_ATTEMPTS) return 0;
  const index = Math.min(n - PIN_FREE_ATTEMPTS - 1, PIN_LOCKOUT_LADDER_MS.length - 1);
  return PIN_LOCKOUT_LADDER_MS[index];
}

/** Rough, human duration. "about 5 minutes" reads better than a timestamp. */
function formatWait(ms) {
  const seconds = Math.max(1, Math.ceil(Number(ms) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Current lockout state of a session row.
 * A missing column (migration not applied) reads as not locked.
 *
 * @param {object|null} session
 */
function pinLockState(session) {
  const until = session?.pin_locked_until;
  if (!until) return { locked: false, until: null, remainingMs: 0 };
  const ts = new Date(until).getTime();
  if (!Number.isFinite(ts)) return { locked: false, until: null, remainingMs: 0 };
  const remainingMs = ts - Date.now();
  if (remainingMs <= 0) return { locked: false, until: null, remainingMs: 0 };
  return { locked: true, until: new Date(ts).toISOString(), remainingMs };
}

/**
 * True when the failure is "those columns do not exist yet".
 * Same tolerance as the is_locked path below: an unapplied migration must not
 * take unlock down, it must only cost us the counter until it lands.
 */
function isMissingLockoutColumn(error) {
  return /failed_pin_attempts|pin_locked_until/i.test(error?.message || '');
}

/**
 * Count one wrong secret and apply the lock the count has earned.
 *
 * Writes only the two lockout columns on an existing row, so nothing about the
 * lock or the TTL is disturbed. When there is no row yet there is also no lock
 * (an absent row means an open session), and the row this inserts keeps it
 * open: it carries a normal TTL, which is stricter than the absent row it
 * replaces, never looser.
 *
 * @returns {Promise<{ attempts: number, lockedForMs: number }>}
 */
async function recordFailedPinAttempt(accountId, channel, externalId, session) {
  const ch = normalizeChannel(channel);
  const id = normalizeExternalId(externalId);
  const attempts = Number(session?.failed_pin_attempts || 0) + 1;
  const lockedForMs = pinLockoutMsForAttempts(attempts);

  const patch = { failed_pin_attempts: attempts };
  if (lockedForMs > 0) {
    patch.pin_locked_until = new Date(Date.now() + lockedForMs).toISOString();
  }

  const supabase = getSupabase();

  const applyPatch = async () => {
    const { error } = await supabase
      .from('sessions')
      .update(patch)
      .eq('account_id', accountId)
      .eq('channel', ch)
      .eq('external_id', id);
    return error;
  };

  let error;
  if (session) {
    error = await applyPatch();
  } else {
    const now = new Date().toISOString();
    const insert = await supabase.from('sessions').insert({
      account_id: accountId,
      channel: ch,
      external_id: id,
      last_active_at: now,
      unlocked_at: now,
      expires_at: new Date(Date.now() + config.sessionTtlMs).toISOString(),
      is_locked: false,
      failed_pin_attempts: attempts,
      pin_locked_until: patch.pin_locked_until || null,
    });
    // A row can appear between the read and the insert. Patch it instead.
    error = insert.error ? await applyPatch() : null;
  }

  if (error) {
    if (isMissingLockoutColumn(error)) {
      console.warn(
        '[unlock] sessions.failed_pin_attempts / pin_locked_until missing. Brute-force lockout is NOT active. Run migration 20260729120000_session_pin_lockout.sql'
      );
    } else {
      console.warn(`[unlock] could not record failed attempt: ${error.message}`);
    }
    return { attempts, lockedForMs: 0 };
  }

  return { attempts, lockedForMs };
}

/**
 * Wipe the counter and the lock.
 *
 * Only two things may call this: a correct secret below, and the
 * password-authenticated PIN reset on the site. Nothing that merely touches a
 * session may, or holding the phone would be enough to clear it.
 */
async function clearPinLockout(accountId, channel, externalId) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('sessions')
    .update({ failed_pin_attempts: 0, pin_locked_until: null })
    .eq('account_id', accountId)
    .eq('channel', normalizeChannel(channel))
    .eq('external_id', normalizeExternalId(externalId));
  if (error && !isMissingLockoutColumn(error)) {
    console.warn(`[unlock] could not clear lockout: ${error.message}`);
  }
}

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
 *
 * Deliberately never names failed_pin_attempts or pin_locked_until. On conflict
 * this updates only the columns listed below, so an ordinary message arriving
 * cannot wash away a brute-force counter.
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
 * Both secrets are compared inside verifyPin/verifyPassword, which derive with
 * scrypt and finish on crypto.timingSafeEqual over equal-length buffers, so
 * there is no string compare here to leak a prefix. A stored hash of the wrong
 * shape returns false rather than throwing.
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

  // Read the session before anything else. A locked-out session is refused
  // here, above the hashes: the point is that the secret is never compared, so
  // guess 5,001 tells the attacker nothing at all.
  let session = null;
  try {
    session = await getSession(account.id, channel, externalId);
  } catch (err) {
    console.warn(`[unlock] session read failed: ${err.message}`);
  }
  const lock = pinLockState(session);
  if (lock.locked) {
    console.warn(
      `[unlock] refused, locked out account=${account.id} channel=${normalizeChannel(channel)} until=${lock.until}`
    );
    return {
      ok: false,
      reason: 'pin_locked',
      lockedUntil: lock.until,
      retryAfterMs: lock.remainingMs,
      retryAfterText: formatWait(lock.remainingMs),
    };
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
    // Nothing to guess yet, so nothing to count.
    if (!hasPin && !hasPassword) {
      return { ok: false, reason: 'no_pin' };
    }
    const counted = await recordFailedPinAttempt(account.id, channel, externalId, session);
    console.warn(
      `[unlock] bad secret account=${account.id} channel=${normalizeChannel(channel)} hasPin=${hasPin} hasPassword=${hasPassword} len=${secretTrimmed.length} attempts=${counted.attempts}`
    );
    return {
      ok: false,
      reason: 'bad_pin',
      hasPin,
      hasPassword,
      attempts: counted.attempts,
      attemptsLeft: Math.max(0, PIN_FREE_ATTEMPTS + 1 - counted.attempts),
      lockedForMs: counted.lockedForMs,
      retryAfterText: counted.lockedForMs > 0 ? formatWait(counted.lockedForMs) : null,
    };
  }

  await touchSession(account.id, channel, externalId);
  // A correct secret is one of only two things that may clear the counter.
  await clearPinLockout(account.id, channel, externalId);
  return { ok: true };
}

/**
 * Lock without password. Blocks bot commands on this channel until unlock.
 * Never sets unlocked_at to null — column is NOT NULL in DB.
 *
 * Like touchSession, it never names the lockout columns: locking must not be a
 * way to reset a counter the person holding the phone has been running up.
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
  clearPinLockout,
  pinLockState,
  pinLockoutMsForAttempts,
  formatWait,
  PIN_FREE_ATTEMPTS,
  PIN_LOCKOUT_LADDER_MS,
};
