/**
 * Email identity helpers for claim-send and account secondary emails.
 *
 * The registration email on accounts.email is always a claim key (ownership is
 * the account password). Additional emails live in account_emails and are only
 * claimable after verified_at is set.
 */

/** Practical address check — not full RFC, enough to refuse junk. */
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * @param {string} raw
 * @returns {string} lowercased trimmed email or empty
 */
function normalizeEmail(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/**
 * @param {string} raw
 * @returns {boolean}
 */
function isValidEmail(raw) {
  const e = normalizeEmail(raw);
  if (!e || e.length > 254) return false;
  if (!EMAIL_RE.test(e)) return false;
  const [local, domain] = e.split('@');
  if (!local || !domain || local.length > 64) return false;
  if (domain.includes('..')) return false;
  return true;
}

/**
 * @param {string} raw
 * @returns {string} normalized email or empty when invalid
 */
function parseEmail(raw) {
  const e = normalizeEmail(raw);
  return isValidEmail(e) ? e : '';
}

/**
 * Public / menu display: show first char + domain tail.
 * @param {string} raw
 */
function maskEmail(raw) {
  const e = normalizeEmail(raw);
  if (!e || !e.includes('@')) return 'email';
  const [local, domain] = e.split('@');
  const head = local.slice(0, 1) || '?';
  return `${head}…@${domain}`;
}

/**
 * Safe single-line label for plans (full address the sender typed).
 * @param {string} raw
 * @param {(s: string) => string} [safe]
 */
function emailLabel(raw, safe) {
  const e = normalizeEmail(raw);
  if (!e) return 'email';
  return safe ? safe(e) : e;
}

module.exports = {
  EMAIL_RE,
  normalizeEmail,
  isValidEmail,
  parseEmail,
  maskEmail,
  emailLabel,
};
