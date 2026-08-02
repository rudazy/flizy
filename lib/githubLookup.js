/**
 * Resolve a GitHub login to the immutable numeric user id.
 *
 * Claims and binds store the id, never the handle. At send time the sender
 * types a familiar login; we ask GitHub once, then route by id.
 *
 * Public API, no OAuth required. Optional GITHUB_API_TOKEN raises rate limits.
 * Pure enough to mock fetch in tests via dependency injection.
 */

const GITHUB_LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

/**
 * @param {string} raw
 * @returns {string} bare login or empty
 */
function normalizeGitHubLogin(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/^@+/, '');
  if (!s || s.length > 39) return '';
  if (!GITHUB_LOGIN_RE.test(s)) return '';
  return s;
}

/**
 * @param {string} login
 * @param {{ fetch?: typeof fetch }} [opts]
 * @returns {Promise<{ id: string, login: string } | null>}
 */
async function resolveGitHubUser(login, opts = {}) {
  const name = normalizeGitHubLogin(login);
  if (!name) {
    const err = new Error('Invalid GitHub username.');
    err.code = 'GITHUB_LOGIN_INVALID';
    throw err;
  }

  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('GitHub lookup is unavailable (no fetch).');
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Flizy-App',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Optional PAT for higher rate limits. Never the OAuth client secret.
  if (process.env.GITHUB_API_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_API_TOKEN}`;
  }

  const url = `https://api.github.com/users/${encodeURIComponent(name)}`;
  const res = await fetchFn(url, { headers });

  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    const err = new Error('GitHub is rate-limiting lookups. Try again in a minute.');
    err.code = 'GITHUB_RATE_LIMIT';
    throw err;
  }
  if (!res.ok) {
    const err = new Error('Could not look up that GitHub user. Try again shortly.');
    err.code = 'GITHUB_LOOKUP_FAILED';
    throw err;
  }

  const data = await res.json();
  const id = data && data.id != null ? String(data.id) : '';
  const resolvedLogin = data && data.login ? String(data.login) : name;
  if (!/^\d+$/.test(id)) {
    const err = new Error('GitHub returned an unexpected profile.');
    err.code = 'GITHUB_LOOKUP_FAILED';
    throw err;
  }
  return { id, login: resolvedLogin };
}

module.exports = {
  normalizeGitHubLogin,
  resolveGitHubUser,
};
