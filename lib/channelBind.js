/**
 * Bind a verified identity to an account.
 *
 * Platform-agnostic on purpose. This knows channel, external_id, display_handle,
 * account_id and a rebind policy. It does not know GitHub, Discord, X, ENS or
 * Farcaster. Verification happens outside and binding happens inside, so the
 * day a wallet signature replaces an OAuth round trip, only the caller changes.
 *
 * THE INVARIANT: the external_id reaching this function is always
 * verification-proven. No API anywhere accepts a caller-supplied external_id.
 * That is what makes identity enumeration impossible, and it is also why the
 * per-account lockout below has so little to bite on.
 *
 * This exists because an OAuth callback that merely inserts a row inherits none
 * of what lib/identity.js consumeLinkCode already earned. The four protections
 * it carries, in this order:
 *
 *   1. lockout before any lookup, so a locked-out caller learns nothing
 *   2. existence lookup, with the cross-account case decided by policy
 *   3. one-identity-per-channel for platform channels
 *   4. insert, with 23505 resolved by which constraint actually fired
 *
 * MIRROR: web/lib/channelBind.ts is a hand-kept copy of this file, because the
 * Vercel Root Directory is web, so ../lib is never uploaded to the deploy and
 * importing root lib/ from web would pass locally and fail in production.
 * test/webChannelBind.test.js pins both against the same vectors.
 *
 * EXIT CRITERIA for the mirror: when the authenticated engine HTTP API exists,
 * the web callback binds through it, web/lib/channelBind.ts is deleted, and both
 * runtimes bind through this one path. Dropping the mirror before then needs a
 * real Vercel preview build proving ../lib resolves in the deploy. The
 * duplication is intentional and temporary; do not grow it.
 */

const { assertChannel, normalizeExternalId, isPlatformChannel } = require('./channelKey');
const { displaySafeLabel } = require('./sanitize');
const {
  FREE_ATTEMPTS,
  lockoutMsForAttempts,
  formatWait,
  lockStateFrom,
} = require('./lockoutLadder');

const IDENTITY_TABLE = 'channel_identities';
const EVENTS_TABLE = 'identity_events';
const ATTEMPTS_TABLE = 'identity_bind_attempts';

/**
 * Index names, matched against a 23505 to tell two very different races apart.
 * Renaming either index without changing these turns a loud rejection into a
 * mishandled race, so they are pinned by test/channelBind.test.js.
 */
const IDENTITY_UNIQUE_INDEX = 'channel_identities_channel_external_idx';
const ACCOUNT_PLATFORM_UNIQUE_INDEX = 'channel_identities_account_platform_idx';

/** What a completed bind did. */
const BIND_OUTCOME = Object.freeze({
  LINKED: 'LINKED',
  ALREADY_LINKED: 'ALREADY_LINKED',
  HANDLE_REFRESHED: 'HANDLE_REFRESHED',
  MOVED: 'MOVED',
});

/** Rows written to identity_events. */
const IDENTITY_EVENT = Object.freeze({
  LINKED: 'LINKED',
  UNLINKED: 'UNLINKED',
  HANDLE_REFRESHED: 'HANDLE_REFRESHED',
  LINK_REJECTED_ALREADY_TAKEN: 'LINK_REJECTED_ALREADY_TAKEN',
  LINK_REJECTED_ALREADY_LINKED: 'LINK_REJECTED_ALREADY_LINKED',
});

/** What to do when the identity is already bound to a different account. */
const REBIND_POLICY = Object.freeze({
  /** consumeLinkCode. A link code is a fresh single-use proof of intent. */
  MOVE: 'move',
  /** OAuth. No equivalent proof, so a silent move would be a hijack. */
  REJECT: 'reject',
});

class BindError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BindError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Postgres unique violation. */
function isUniqueViolation(error) {
  return error && String(error.code) === '23505';
}

/** Which unique index a 23505 came from. Empty when it cannot be told. */
function violatedIndex(error) {
  const text = `${error?.message || ''} ${error?.details || ''}`;
  if (text.includes(ACCOUNT_PLATFORM_UNIQUE_INDEX)) return ACCOUNT_PLATFORM_UNIQUE_INDEX;
  if (text.includes(IDENTITY_UNIQUE_INDEX)) return IDENTITY_UNIQUE_INDEX;
  return '';
}

function isMissingRelation(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === '42P01' || code === 'PGRST205' || /does not exist/i.test(message);
}

/**
 * A handle is somebody else's text. It is flattened on the way in as well as on
 * the way out, so a stored newline can never reach a screen that forgot to
 * sanitize. The leading at sign is dropped so it is stored once, not twice.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeDisplayHandle(raw) {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim().replace(/^@+/, '');
  const safe = displaySafeLabel(trimmed);
  return safe || null;
}

// ---------------------------------------------------------------------------
// Lockout, keyed per account
// ---------------------------------------------------------------------------

/**
 * A missing table degrades to "not locked" with a loud warning, the same way
 * lib/linkAttempts.js does. That is a deliberate trade: this ladder is depth
 * rather than the primary defence (the OAuth proof and the per-route limit are),
 * so an unapplied migration should not take the whole bind offline.
 *
 * @returns {Promise<{ locked: boolean, until: string|null, remainingMs: number, retryAfterText: string|null }>}
 */
async function bindLockState(supabase, accountId) {
  const open = { locked: false, until: null, remainingMs: 0, retryAfterText: null };
  if (!accountId) return open;

  const { data, error } = await supabase
    .from(ATTEMPTS_TABLE)
    .select('failed_attempts, locked_until')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error) {
    if (isMissingRelation(error)) {
      console.warn(
        `[bind] ${ATTEMPTS_TABLE} missing. Bind lockout is NOT active. Run migration 20260802170000_identity_bind_attempts.sql`
      );
      return open;
    }
    console.warn(`[bind] lock read failed: ${error.message}`);
    return open;
  }

  const state = lockStateFrom(data?.locked_until);
  return {
    ...state,
    retryAfterText: state.locked ? formatWait(state.remainingMs) : null,
  };
}

/**
 * Count one rejected bind. Both LINK_REJECTED_* outcomes come through here:
 * either is cheap to trigger repeatedly, so either earns the ladder.
 */
async function recordRejectedBind(supabase, accountId) {
  const result = { attempts: 0, lockedForMs: 0, attemptsLeft: FREE_ATTEMPTS, retryAfterText: null };
  if (!accountId) return result;

  const { data, error: readErr } = await supabase
    .from(ATTEMPTS_TABLE)
    .select('failed_attempts')
    .eq('account_id', accountId)
    .maybeSingle();

  if (readErr && isMissingRelation(readErr)) return result;

  const attempts = Number(data?.failed_attempts || 0) + 1;
  const lockedForMs = lockoutMsForAttempts(attempts);

  const patch = {
    account_id: accountId,
    failed_attempts: attempts,
    last_attempt_at: new Date().toISOString(),
  };
  if (lockedForMs > 0) {
    patch.locked_until = new Date(Date.now() + lockedForMs).toISOString();
  }

  const { error } = await supabase
    .from(ATTEMPTS_TABLE)
    .upsert(patch, { onConflict: 'account_id' });
  if (error && !isMissingRelation(error)) {
    console.warn(`[bind] attempt write failed: ${error.message}`);
  }

  return {
    attempts,
    lockedForMs,
    attemptsLeft: Math.max(0, FREE_ATTEMPTS + 1 - attempts),
    retryAfterText: lockedForMs > 0 ? formatWait(lockedForMs) : null,
  };
}

/** Only a bind that succeeds clears the counter, same rule as the PIN and link paths. */
async function clearBindAttempts(supabase, accountId) {
  if (!accountId) return;
  const { error } = await supabase
    .from(ATTEMPTS_TABLE)
    .update({ failed_attempts: 0, locked_until: null })
    .eq('account_id', accountId);
  if (error && !isMissingRelation(error)) {
    console.warn(`[bind] could not clear attempts: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * One row per outcome. Never throws: a failed audit write must not roll back a
 * bind that already happened, which would leave the caller unable to tell what
 * state they are in. A failure is warned loudly instead.
 */
async function logIdentityEvent(supabase, { accountId, channel, externalId, displayHandle, eventType }) {
  try {
    const { error } = await supabase.from(EVENTS_TABLE).insert({
      account_id: accountId || null,
      channel,
      external_id: externalId,
      display_handle: displayHandle || null,
      event_type: eventType,
    });
    if (error) {
      if (isMissingRelation(error)) {
        console.warn(
          `[bind] ${EVENTS_TABLE} missing. Identity audit is NOT being written. Run migration 20260802160000_identity_events.sql`
        );
        return;
      }
      console.warn(`[bind] audit write failed (${eventType}): ${error.message}`);
    }
  } catch (err) {
    console.warn(`[bind] audit write threw (${eventType}): ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// The core
// ---------------------------------------------------------------------------

async function readIdentity(supabase, channel, externalId) {
  const { data, error } = await supabase
    .from(IDENTITY_TABLE)
    .select('id, account_id, channel, external_id, display_handle, phone_e164')
    .eq('channel', channel)
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) throw new Error(`identity lookup failed: ${error.message}`);
  return data || null;
}

/**
 * Bind (channel, externalId) to accountId.
 *
 * @param {object} supabase injected so the bot, the web app and the drift test
 *   all drive the same code against their own client
 * @param {object} p
 * @param {string} p.accountId
 * @param {string} p.channel
 * @param {string} p.externalId verification-proven, never caller-supplied
 * @param {string} [p.displayHandle] display only, never matched on
 * @param {'move'|'reject'} [p.rebindPolicy] what to do when it belongs elsewhere
 * @param {object} [p.extraColumns] extra columns for the insert (phone_e164)
 * @returns {Promise<{ outcome: string, identity: object }>}
 * @throws {BindError} LOCKED | IDENTITY_TAKEN | ALREADY_LINKED_DIFFERENT
 */
async function bindChannelIdentity(supabase, p) {
  const accountId = p?.accountId;
  const channel = assertChannel(p?.channel, 'bindChannelIdentity');
  const externalId = normalizeExternalId(p?.externalId);
  const displayHandle = normalizeDisplayHandle(p?.displayHandle);
  const rebindPolicy = p?.rebindPolicy === REBIND_POLICY.MOVE ? REBIND_POLICY.MOVE : REBIND_POLICY.REJECT;
  const extraColumns = p?.extraColumns || {};

  if (!accountId) throw new BindError('INVALID', 'bindChannelIdentity: missing accountId');
  if (!externalId) throw new BindError('INVALID', 'bindChannelIdentity: missing externalId');

  // 1. Lockout before any lookup. Above the read on purpose: a locked-out caller
  //    must not learn whether the identity exists.
  const lock = await bindLockState(supabase, accountId);
  if (lock.locked) {
    throw new BindError('LOCKED', 'Too many rejected links. Try again later.', {
      lockedUntil: lock.until,
      retryAfterMs: lock.remainingMs,
      retryAfterText: lock.retryAfterText,
    });
  }

  // 2. Existence lookup.
  const existing = await readIdentity(supabase, channel, externalId);
  if (existing) {
    if (existing.account_id === accountId) {
      return refreshOwnIdentity(supabase, existing, {
        accountId,
        channel,
        externalId,
        displayHandle,
        extraColumns,
      });
    }
    return resolveCrossAccount(supabase, existing, {
      accountId,
      channel,
      externalId,
      displayHandle,
      rebindPolicy,
      extraColumns,
    });
  }

  // 3. One identity per channel, platform channels only.
  //    Chat channels are excluded so a changed WhatsApp LID can still be
  //    re-linked by redeeming a code, which inserts a second whatsapp row.
  if (isPlatformChannel(channel)) {
    const { data: held, error } = await supabase
      .from(IDENTITY_TABLE)
      .select('external_id')
      .eq('account_id', accountId)
      .eq('channel', channel)
      .maybeSingle();
    if (error && !isMissingRelation(error)) {
      throw new Error(`identity lookup failed: ${error.message}`);
    }
    if (held && normalizeExternalId(held.external_id) !== externalId) {
      return rejectAlreadyLinked(supabase, { accountId, channel, externalId, displayHandle });
    }
  }

  // 4. Insert.
  const row = {
    account_id: accountId,
    channel,
    external_id: externalId,
    ...(displayHandle ? { display_handle: displayHandle } : {}),
    ...extraColumns,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from(IDENTITY_TABLE)
    .insert(row)
    .select('*')
    .single();

  if (!insertErr) {
    await clearBindAttempts(supabase, accountId);
    await logIdentityEvent(supabase, {
      accountId,
      channel,
      externalId,
      displayHandle,
      eventType: IDENTITY_EVENT.LINKED,
    });
    return { outcome: BIND_OUTCOME.LINKED, identity: inserted };
  }

  if (!isUniqueViolation(insertErr)) {
    throw new Error(`identity bind failed: ${insertErr.message}`);
  }

  // Which unique fired decides what this was. Two very different races share
  // one error code, so the constraint name is the only honest signal.
  if (violatedIndex(insertErr) === ACCOUNT_PLATFORM_UNIQUE_INDEX) {
    return rejectAlreadyLinked(supabase, { accountId, channel, externalId, displayHandle });
  }

  // A concurrent bind won the race for this identity. Re-read and apply the
  // same rule step 2 would have.
  const raced = await readIdentity(supabase, channel, externalId);
  if (!raced) {
    throw new Error('identity bind failed: unique violation with no row to resolve');
  }
  if (raced.account_id === accountId) {
    return refreshOwnIdentity(supabase, raced, {
      accountId,
      channel,
      externalId,
      displayHandle,
      extraColumns,
    });
  }
  return resolveCrossAccount(supabase, raced, {
    accountId,
    channel,
    externalId,
    displayHandle,
    rebindPolicy,
    extraColumns,
  });
}

/** The identity is already ours. Idempotent success, refreshing the label. */
async function refreshOwnIdentity(supabase, existing, ctx) {
  const patch = { ...ctx.extraColumns };
  const handleChanged = ctx.displayHandle && ctx.displayHandle !== existing.display_handle;
  if (handleChanged) patch.display_handle = ctx.displayHandle;

  let identity = existing;
  if (Object.keys(patch).length) {
    const { data, error } = await supabase
      .from(IDENTITY_TABLE)
      .update(patch)
      .eq('channel', ctx.channel)
      .eq('external_id', ctx.externalId)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`identity update failed: ${error.message}`);
    identity = data || existing;
  }

  await clearBindAttempts(supabase, ctx.accountId);

  if (handleChanged) {
    await logIdentityEvent(supabase, {
      accountId: ctx.accountId,
      channel: ctx.channel,
      externalId: ctx.externalId,
      displayHandle: ctx.displayHandle,
      eventType: IDENTITY_EVENT.HANDLE_REFRESHED,
    });
    return { outcome: BIND_OUTCOME.HANDLE_REFRESHED, identity };
  }

  return { outcome: BIND_OUTCOME.ALREADY_LINKED, identity };
}

/**
 * The identity is bound to someone else.
 *
 * "move" is consumeLinkCode's behaviour and is safe there because the code is a
 * fresh single-use proof of intent for one specific account. OAuth has no such
 * proof, so "reject" is the default: otherwise anyone controlling the platform
 * account could redirect that handle's payouts without the old account's
 * password.
 */
async function resolveCrossAccount(supabase, existing, ctx) {
  if (ctx.rebindPolicy !== REBIND_POLICY.MOVE) {
    await recordRejectedBind(supabase, ctx.accountId);
    await logIdentityEvent(supabase, {
      accountId: ctx.accountId,
      channel: ctx.channel,
      externalId: ctx.externalId,
      displayHandle: ctx.displayHandle,
      eventType: IDENTITY_EVENT.LINK_REJECTED_ALREADY_TAKEN,
    });
    throw new BindError('IDENTITY_TAKEN', 'That account is already linked to another Flizy account.');
  }

  const patch = {
    account_id: ctx.accountId,
    linked_at: new Date().toISOString(),
    ...ctx.extraColumns,
  };
  if (ctx.displayHandle) patch.display_handle = ctx.displayHandle;

  const { data, error } = await supabase
    .from(IDENTITY_TABLE)
    .update(patch)
    .eq('channel', ctx.channel)
    .eq('external_id', ctx.externalId)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`identity move failed: ${error.message}`);

  await clearBindAttempts(supabase, ctx.accountId);
  await logIdentityEvent(supabase, {
    accountId: ctx.accountId,
    channel: ctx.channel,
    externalId: ctx.externalId,
    displayHandle: ctx.displayHandle,
    eventType: IDENTITY_EVENT.LINKED,
  });
  return { outcome: BIND_OUTCOME.MOVED, identity: data || existing };
}

/** This account already holds a different identity on this channel. */
async function rejectAlreadyLinked(supabase, ctx) {
  await recordRejectedBind(supabase, ctx.accountId);
  await logIdentityEvent(supabase, {
    accountId: ctx.accountId,
    channel: ctx.channel,
    externalId: ctx.externalId,
    displayHandle: ctx.displayHandle,
    eventType: IDENTITY_EVENT.LINK_REJECTED_ALREADY_LINKED,
  });
  throw new BindError(
    'ALREADY_LINKED_DIFFERENT',
    'This account already has a different one linked. Unlink it first.'
  );
}

/**
 * Remove an identity (platform or chat) from an account.
 *
 * Site callers gate this on a password re-entry: unlinking changes where future
 * payments can go (phone claims join on phone_e164; platforms on external id).
 * Chat can call this for the current channel after the user types unlink there
 * (being in that chat is the proof).
 *
 * Channels: whatsapp, telegram, github, discord, x.
 */
async function unlinkChannelIdentity(supabase, { accountId, channel }) {
  const ch = assertChannel(channel, 'unlinkChannelIdentity');
  if (!accountId) throw new BindError('INVALID', 'unlinkChannelIdentity: missing accountId');

  const { data: rows, error } = await supabase
    .from(IDENTITY_TABLE)
    .delete()
    .eq('account_id', accountId)
    .eq('channel', ch)
    .select('*');
  if (error) throw new Error(`identity unlink failed: ${error.message}`);

  const removed = rows || [];
  for (const row of removed) {
    await logIdentityEvent(supabase, {
      accountId,
      channel: ch,
      externalId: row.external_id,
      displayHandle: row.display_handle,
      eventType: IDENTITY_EVENT.UNLINKED,
    });
  }
  return { removed: removed.length, identities: removed };
}

module.exports = {
  BIND_OUTCOME,
  IDENTITY_EVENT,
  REBIND_POLICY,
  BindError,
  IDENTITY_UNIQUE_INDEX,
  ACCOUNT_PLATFORM_UNIQUE_INDEX,
  normalizeDisplayHandle,
  bindLockState,
  recordRejectedBind,
  clearBindAttempts,
  logIdentityEvent,
  bindChannelIdentity,
  unlinkChannelIdentity,
};
