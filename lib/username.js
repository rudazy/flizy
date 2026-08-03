/**
 * Flizy-native @username.
 *
 * For recognition in notifications and UI after onboarding.
 * Never a payment routing key (platform ids and phones still are).
 */

const { displaySafeLabel } = require('./sanitize');

/** Reserved so we never look like system or product surfaces. */
const RESERVED = new Set([
  'admin',
  'administrator',
  'flizy',
  'support',
  'help',
  'api',
  'root',
  'system',
  'null',
  'undefined',
  'me',
  'you',
  'claim',
  'send',
  'pay',
  'official',
]);

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
 * @param {string} raw
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
  if (!/^[a-z][a-z0-9_]*$/.test(u)) {
    return {
      ok: false,
      error: 'Username must start with a letter and use only letters, numbers, underscore.',
    };
  }
  if (RESERVED.has(u)) {
    return { ok: false, error: 'That username is reserved.' };
  }
  return { ok: true, username: u };
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

module.exports = {
  RESERVED,
  normalizeUsername,
  validateUsername,
  formatUsernameLabel,
};
