/**
 * Attempt limiting for `flizy link CODE`.
 *
 * Same ladder as the failed-PIN lockout (lib/lockoutLadder.js, shared not
 * copied), different key. The PIN counter hangs off the sessions row because by
 * then we know whose account it is. A link attempt is the opposite situation: the
 * guesser is not linked to anything yet, which is the whole point of guessing, so
 * there is no account to key on and the counter lives on (channel, external_id)
 * in its own table.
 *
 * The way back in without waiting is generating a fresh code on the site, which
 * is what a legitimate user who mistyped would do anyway.
 *
 * Degrades to a warning when the table is missing, the same way the PIN counter
 * does before its migration lands: an unapplied migration must not take linking
 * down for everybody. Entropy (50 bits, see lib/linkCode.js) is the primary
 * defence and this is the second layer.
 */

const { getSupabase } = require('./supabase');
const { assertChannel, normalizeExternalId } = require('./channelKey');
const {
  FREE_ATTEMPTS,
  lockoutMsForAttempts,
  formatWait,
  lockStateFrom,
} = require('./lockoutLadder');

const TABLE = 'link_code_attempts';

/** True when the failure is "that table does not exist yet". */
function isMissingTable(error) {
  const code = error?.code ? String(error.code) : '';
  const message = error?.message || '';
  return code === '42P01' || code === 'PGRST205' || new RegExp(TABLE).test(message);
}

function warnMissing() {
  console.warn(
    `[link] ${TABLE} missing. Link-code attempt limiting is NOT active. Run migration 20260730120000_link_code_attempts.sql`
  );
}

async function readRow(channel, externalId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from(TABLE)
    .select('channel, external_id, failed_attempts, locked_until')
    .eq('channel', assertChannel(channel, 'linkAttempts.readRow'))
    .eq('external_id', normalizeExternalId(externalId))
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) {
      warnMissing();
      return { row: null, degraded: true };
    }
    console.warn(`[link] attempt read failed: ${error.message}`);
    return { row: null, degraded: true };
  }
  return { row: data || null, degraded: false };
}

/**
 * Is this chat identity currently barred from trying a code?
 * Checked before the code is looked up at all, so a locked-out guesser learns
 * nothing about whether their guess existed.
 *
 * @returns {Promise<{ locked: boolean, until: string|null, remainingMs: number, retryAfterText: string|null }>}
 */
async function linkLockState(channel, externalId) {
  const { row } = await readRow(channel, externalId);
  const state = lockStateFrom(row?.locked_until);
  return {
    ...state,
    retryAfterText: state.locked ? formatWait(state.remainingMs) : null,
  };
}

/**
 * Count one wrong code and apply whatever lock the count has earned.
 *
 * @returns {Promise<{ attempts: number, lockedForMs: number, retryAfterText: string|null, attemptsLeft: number }>}
 */
async function recordFailedLinkAttempt(channel, externalId) {
  const ch = assertChannel(channel, 'recordFailedLinkAttempt');
  const id = normalizeExternalId(externalId);
  const { row, degraded } = await readRow(ch, id);
  const attempts = Number(row?.failed_attempts || 0) + 1;
  const lockedForMs = lockoutMsForAttempts(attempts);

  const result = {
    attempts,
    lockedForMs,
    retryAfterText: lockedForMs > 0 ? formatWait(lockedForMs) : null,
    attemptsLeft: Math.max(0, FREE_ATTEMPTS + 1 - attempts),
  };

  if (degraded) {
    return { ...result, lockedForMs: 0, retryAfterText: null };
  }

  const supabase = getSupabase();
  const payload = {
    channel: ch,
    external_id: id,
    failed_attempts: attempts,
    locked_until: lockedForMs > 0 ? new Date(Date.now() + lockedForMs).toISOString() : null,
    last_attempt_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'channel,external_id' });

  if (error) {
    if (isMissingTable(error)) warnMissing();
    else console.warn(`[link] could not record failed attempt: ${error.message}`);
    return { ...result, lockedForMs: 0, retryAfterText: null };
  }

  return result;
}

/**
 * Wipe the counter after a code is accepted.
 * Only a correct code may call this, exactly like the PIN path.
 */
async function clearLinkAttempts(channel, externalId) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from(TABLE)
    .update({ failed_attempts: 0, locked_until: null })
    .eq('channel', assertChannel(channel, 'clearLinkAttempts'))
    .eq('external_id', normalizeExternalId(externalId));
  if (error && !isMissingTable(error)) {
    console.warn(`[link] could not clear attempts: ${error.message}`);
  }
}

module.exports = {
  linkLockState,
  recordFailedLinkAttempt,
  clearLinkAttempts,
};
