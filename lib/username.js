/**
 * Flizy-native @username.
 *
 * Recognition in notifications and UI after onboarding.
 * Never a payment routing key (platform ids and phones still are).
 *
 * Rules (product):
 * - letters + digits only (no underscore, no specials)
 * - must start with a letter, 3-24 chars, lowercase stored
 * - required at signup (via profile gate)
 * - change at most once every 30 days
 * - not for Hangul/Han (those belong in display_name)
 * - reserved names live in public.reserved_usernames (DB), matched on reservedKey
 */

const { displaySafeLabel } = require('./sanitize');

/** 30 days in ms */
const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Client-facing copy for reserved and taken (identical on purpose). */
const USERNAME_UNAVAILABLE = 'That username is unavailable.';

/**
 * @param {string} raw
 * @returns {string} canonical lowercase username or ''
 */
function normalizeUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

/**
 * Key used for reserved-name lookup and storage.
 *
 * Seeds in reserved_usernames.normalized_name are stored as reservedKey(name),
 * never the raw display form. Lookup always runs the same function so seeds
 * and checks cannot drift.
 *
 * Given the format charset (a-z0-9 only after validateUsername), strip of
 * non-alphanumerics is a no-op for valid claims. Collapse of runs of the same
 * character is what makes supportt and support share one entry:
 *   support  -> suport
 *   supportt -> suport
 *
 * @param {unknown} raw
 * @returns {string}
 */
function reservedKey(raw) {
  let u = normalizeUsername(raw);
  u = u.replace(/[^a-z0-9]/g, '');
  u = u.replace(/(.)\1+/g, '$1');
  return u;
}

/**
 * Format-only validation. Reserved check is separate (DB or injected set).
 *
 * @param {unknown} raw
 * @returns {{ ok: true, username: string } | { ok: false, error: string }}
 */
function validateUsername(raw) {
  const u = normalizeUsername(raw);
  if (!u) {
    return { ok: false, error: 'Username is required.' };
  }
  if (u.length < 3) {
    return { ok: false, error: 'Username must be at least 3 characters.' };
  }
  if (u.length > 24) {
    return { ok: false, error: 'Username must be at most 24 characters.' };
  }
  // ASCII a-z then a-z0-9 only -- no underscore, no Unicode scripts.
  if (!/^[a-z][a-z0-9]*$/.test(u)) {
    return {
      ok: false,
      error: 'Username must start with a letter and use only letters and numbers (a-z, 0-9).',
    };
  }
  return { ok: true, username: u };
}

/**
 * Sync reserved check against an injected set of reservedKey values.
 * Used in unit tests; production routes query the DB instead.
 *
 * @param {unknown} raw
 * @param {Set<string>|Iterable<string>} reservedKeys
 * @returns {boolean}
 */
function isReservedAgainst(raw, reservedKeys) {
  const key = reservedKey(raw);
  if (!key) return false;
  if (reservedKeys instanceof Set) return reservedKeys.has(key);
  return new Set(reservedKeys).has(key);
}

/**
 * Query public.reserved_usernames for a match on reservedKey(username).
 * Fail closed on query error (caller should treat throw as hard fail).
 *
 * @param {{ from: Function }} supabase
 * @param {unknown} raw
 * @returns {Promise<boolean>}
 */
async function isUsernameReserved(supabase, raw) {
  const key = reservedKey(raw);
  if (!key) return false;
  const { data, error } = await supabase
    .from('reserved_usernames')
    .select('normalized_name')
    .eq('normalized_name', key)
    .maybeSingle();
  if (error) {
    const err = new Error(`reserved_usernames lookup failed: ${error.message || error}`);
    err.cause = error;
    throw err;
  }
  return Boolean(data && data.normalized_name);
}

/**
 * Public label for notifications: @name when set.
 * @param {string|null|undefined} username
 * @returns {string|null}
 */
function formatUsernameLabel(username) {
  const u = normalizeUsername(username || '');
  if (!u) return null;
  return `@${displaySafeLabel(u)}`;
}

/**
 * Whether the account may set or change username right now.
 *
 * - No username yet -> always allowed (first set).
 * - Same as current -> always allowed (idempotent).
 * - No username_changed_at yet with a name -> allowed once (legacy).
 * - Otherwise must wait until last change + 30 days.
 *
 * @param {{
 *   currentUsername?: string|null,
 *   usernameChangedAt?: string|Date|null,
 *   nextUsername: string,
 *   now?: Date,
 * }} p
 * @returns {{
 *   ok: true,
 *   isNoop: boolean,
 * } | {
 *   ok: false,
 *   error: string,
 *   nextChangeAt: string,
 * }}
 */
function assertUsernameChangeAllowed(p) {
  const next = normalizeUsername(p.nextUsername);
  const current = normalizeUsername(p.currentUsername || '');
  const now = p.now || new Date();

  if (current && current === next) {
    return { ok: true, isNoop: true };
  }

  // First-time set
  if (!current) {
    return { ok: true, isNoop: false };
  }

  const lastRaw = p.usernameChangedAt;
  if (!lastRaw) {
    // Legacy row with username but no stamp: allow this one change.
    return { ok: true, isNoop: false };
  }

  const lastMs = new Date(lastRaw).getTime();
  if (!Number.isFinite(lastMs)) {
    return { ok: true, isNoop: false };
  }

  const nextMs = lastMs + USERNAME_CHANGE_COOLDOWN_MS;
  if (now.getTime() >= nextMs) {
    return { ok: true, isNoop: false };
  }

  const nextChangeAt = new Date(nextMs).toISOString();
  return {
    ok: false,
    error: `You can change your username again after ${formatCooldownDate(nextChangeAt)}.`,
    nextChangeAt,
  };
}

/**
 * Client-facing change window for dashboard.
 * @param {string|null|undefined} username
 * @param {string|Date|null|undefined} usernameChangedAt
 * @param {Date} [now]
 */
function usernameChangeWindow(username, usernameChangedAt, now = new Date()) {
  const current = normalizeUsername(username || '');
  if (!current) {
    return { canChangeUsername: true, usernameNextChangeAt: null };
  }
  if (!usernameChangedAt) {
    return { canChangeUsername: true, usernameNextChangeAt: null };
  }
  const lastMs = new Date(usernameChangedAt).getTime();
  if (!Number.isFinite(lastMs)) {
    return { canChangeUsername: true, usernameNextChangeAt: null };
  }
  const nextMs = lastMs + USERNAME_CHANGE_COOLDOWN_MS;
  if (now.getTime() >= nextMs) {
    return { canChangeUsername: true, usernameNextChangeAt: null };
  }
  return {
    canChangeUsername: false,
    usernameNextChangeAt: new Date(nextMs).toISOString(),
  };
}

/** @param {string} iso */
function formatCooldownDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

module.exports = {
  USERNAME_CHANGE_COOLDOWN_MS,
  USERNAME_UNAVAILABLE,
  normalizeUsername,
  reservedKey,
  validateUsername,
  isReservedAgainst,
  isUsernameReserved,
  formatUsernameLabel,
  assertUsernameChangeAllowed,
  usernameChangeWindow,
};
