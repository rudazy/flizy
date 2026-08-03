/**
 * Resolve an X (Twitter) handle to the immutable numeric user id.
 *
 * Requires X_BEARER_TOKEN (or TWITTER_BEARER_TOKEN) for API v2 lookup.
 * Claims and binds store the id, never the handle.
 */

const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/**
 * @param {string} raw
 * @returns {string} bare handle or empty
 */
function normalizeXHandle(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/^@+/, '');
  if (!s || s.length > 15) return '';
  if (!X_HANDLE_RE.test(s)) return '';
  return s;
}

/**
 * @param {string} login
 * @param {{ fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ id: string, login: string } | null>}
 */
async function resolveXUser(login, opts = {}) {
  const name = normalizeXHandle(login);
  if (!name) {
    const err = new Error('Invalid X username.');
    err.code = 'X_LOGIN_INVALID';
    throw err;
  }

  // Numeric id typed directly
  if (/^\d{5,25}$/.test(name)) {
    return { id: name, login: name };
  }

  const bearer =
    process.env.X_BEARER_TOKEN ||
    process.env.TWITTER_BEARER_TOKEN ||
    process.env.X_API_BEARER_TOKEN ||
    '';
  if (!bearer) {
    const err = new Error(
      'X lookups are not configured yet. An admin must set X_BEARER_TOKEN on the bot.'
    );
    err.code = 'X_LOOKUP_UNAVAILABLE';
    throw err;
  }

  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('X lookup is unavailable (no fetch).');
  }

  const url = `https://api.twitter.com/2/users/by/username/${encodeURIComponent(name)}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      'User-Agent': 'Flizy-App',
    },
  });

  if (res.status === 404) return null;
  if (res.status === 429) {
    const err = new Error('X is rate-limiting lookups. Try again in a minute.');
    err.code = 'X_RATE_LIMIT';
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error('X lookup is not authorized. Check X_BEARER_TOKEN.');
    err.code = 'X_LOOKUP_UNAUTHORIZED';
    throw err;
  }
  if (!res.ok) {
    const err = new Error('Could not look up that X user. Try again shortly.');
    err.code = 'X_LOOKUP_FAILED';
    throw err;
  }

  const body = await res.json();
  const id = body?.data?.id != null ? String(body.data.id) : '';
  const resolved = body?.data?.username ? String(body.data.username) : name;
  if (!/^\d+$/.test(id)) {
    const err = new Error('X returned an unexpected profile.');
    err.code = 'X_LOOKUP_FAILED';
    throw err;
  }
  return { id, login: resolved };
}

module.exports = {
  normalizeXHandle,
  resolveXUser,
};
