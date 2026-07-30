/**
 * The escalating lockout ladder, shared by every guessable credential.
 *
 * It started as the failed-PIN counter in lib/session.js. Link codes need the
 * same thing for the same reason, so the shape lives here and both use it
 * rather than drifting into two mechanisms that punish differently. Anything
 * else guessable added later should come here too.
 *
 * The ladder can be this steep only because each caller offers a way back in
 * that does not involve waiting it out (proving the account password on the site
 * for the PIN, generating a fresh code for a link). Keep that true.
 */

/** Wrong guesses that cost nothing but the guess. */
const FREE_ATTEMPTS = 4;

/** Lock earned by the 5th consecutive wrong secret, then the 6th, and so on. */
const LOCKOUT_LADDER_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

/**
 * Lock duration earned by the Nth consecutive wrong secret. 0 = no lock yet.
 * The top of the ladder repeats forever, so past the 9th wrong try every
 * further guess costs a day.
 *
 * @param {number} attempts
 * @returns {number} ms
 */
function lockoutMsForAttempts(attempts) {
  const n = Number(attempts) || 0;
  if (n <= FREE_ATTEMPTS) return 0;
  const index = Math.min(n - FREE_ATTEMPTS - 1, LOCKOUT_LADDER_MS.length - 1);
  return LOCKOUT_LADDER_MS[index];
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
 * Remaining lockout on a row carrying a `locked_until`-style timestamp.
 * A missing or unparseable value reads as not locked.
 *
 * @param {string|null|undefined} until ISO timestamp
 */
function lockStateFrom(until) {
  if (!until) return { locked: false, until: null, remainingMs: 0 };
  const ts = new Date(until).getTime();
  if (!Number.isFinite(ts)) return { locked: false, until: null, remainingMs: 0 };
  const remainingMs = ts - Date.now();
  if (remainingMs <= 0) return { locked: false, until: null, remainingMs: 0 };
  return { locked: true, until: new Date(ts).toISOString(), remainingMs };
}

module.exports = {
  FREE_ATTEMPTS,
  LOCKOUT_LADDER_MS,
  lockoutMsForAttempts,
  formatWait,
  lockStateFrom,
};
