/**
 * What may leave this machine when an error is reported.
 *
 * Sentry sends error data to a third party. Everything below exists because
 * this is a money app whose errors routinely carry the things that must not go:
 * phone numbers, account ids, email addresses, wallet addresses, and the
 * occasional key. `lib/sanitize.js` already redacts secrets for replies and
 * logs, and it is reused here -- but it does not touch PII, because a reply is
 * read by the person the data is about and a crash report is not.
 *
 * The rule this file enforces:
 *
 *   never send user PII of any kind, wallet keys, API keys, or request bodies
 *
 * plus the 2026-08-31 identity decision that an account id must never appear in
 * a log. An account id in a Sentry event is a log that left the building.
 *
 * Deliberately a denylist over free text rather than an allowlist of fields:
 * the interesting PII arrives inside error *messages* ("no account for
 * 2348012345678"), not in tidy named fields, so it has to be found wherever it
 * is written.
 */

const { SECRET_PATTERNS } = require('./sanitize');

/**
 * Shapes that identify a person, in the order they must be tried.
 *
 * Order matters. An email contains a run of characters that the phone pattern
 * would otherwise chew into, and a 66-character key starts with the same `0x`
 * as a 42-character address, so the longer form is always matched first.
 */
const PII_PATTERNS = [
  // Email, before anything that could eat part of one.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
  // UUID: account ids, request ids, claim ids.
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '[id]'],
  // 0x-prefixed: 64 hex is a key and is already a secret, 40 hex is a wallet.
  [/0x[a-fA-F0-9]{64}\b/g, '[redacted]'],
  [/0x[a-fA-F0-9]{40}\b/g, '[address]'],
  // A run of 10-15 digits, allowing the spaces and hyphens people type. Bare
  // digits are what this app stores, but an error can echo back what a user
  // typed, so "234-801-234-5678" has to go too. Deliberately broad: a false
  // positive costs a less specific crash report, a false negative sends
  // somebody's number to a third party.
  //
  // Known limit: a short numeric id -- a five-digit Telegram id, say -- is not
  // caught, because the threshold that would catch it also eats chain ids,
  // ports and counts, and a report with no numbers left in it is not a report.
  // Those arrive in named fields instead, which DROP_KEYS removes.
  [/\b\d(?:[\s-]?\d){9,14}\b/g, '[phone]'],
];

/** Event keys whose whole value is dropped rather than scrubbed. */
const DROP_KEYS = new Set([
  'cookies',
  'headers',
  'data',
  'body',
  'request_body',
  'query_string',
  'env',
  'user',
  'ip_address',
  'ip',
  'email',
  'phone',
  'username',
  'account_id',
  'accountId',
  'external_id',
  'externalId',
  'agent_wallet_address',
]);

/** How deep to walk before giving up. Sentry events nest, but not far. */
const MAX_DEPTH = 8;

/**
 * Redact every identifying shape in a string.
 * @param {string} text
 * @returns {string}
 */
function scrubText(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  for (const [re, replacement] of PII_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/**
 * Walk a value, scrubbing strings and dropping fields that are PII by name.
 *
 * Returns a new structure; the input is never mutated, because a Sentry
 * beforeSend hook runs on the live error object and mutating it would change
 * what the application itself goes on to log.
 */
function scrubValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (typeof value !== 'object') return undefined;

  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (DROP_KEYS.has(key)) continue;
    const scrubbed = scrubValue(v, depth + 1);
    if (scrubbed !== undefined) out[key] = scrubbed;
  }
  return out;
}

/**
 * Sentry `beforeSend`. Returns the event to send, scrubbed.
 *
 * Never returns null on a scrubbing failure: an error that cannot be cleaned is
 * replaced by one that says so, because silently dropping reports would make
 * the monitoring lie about how often things break.
 */
function scrubEvent(event) {
  try {
    const cleaned = scrubValue(event);
    // Whatever the SDK collected about the person, drop wholesale.
    delete cleaned.user;
    delete cleaned.request;
    delete cleaned.server_name;
    return cleaned;
  } catch {
    return {
      message: 'An error was reported but could not be scrubbed, so it was not sent.',
      level: 'error',
    };
  }
}

module.exports = {
  PII_PATTERNS,
  DROP_KEYS,
  scrubText,
  scrubValue,
  scrubEvent,
};
