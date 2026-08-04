/**
 * Web mirror of lib/channelBind.js.
 *
 * WHY THIS DUPLICATION EXISTS: the ideal is one bind function both runtimes
 * call. web/tsconfig.json already declares an @flizy-lib/* alias to ../lib/*
 * and it typechecks locally, but the Vercel Root Directory is web, so ../lib is
 * never uploaded to the deploy. Importing root lib/ from here would pass on this
 * machine and fail in production.
 *
 * EXIT CRITERIA: when the authenticated engine HTTP API exists, the OAuth
 * callback binds through it, this file is deleted, and both runtimes bind
 * through lib/channelBind.js alone. Dropping the mirror before then needs a real
 * Vercel preview build proving ../lib resolves in the deploy. This duplication
 * is intentional and temporary. Do not grow it, and do not add a third copy.
 *
 * KEEPING IT HONEST: test/webChannelBind.test.js runs this implementation and
 * lib/channelBind.js against identical fake databases and asserts they reach the
 * same outcome, the same rows and the same audit events. Both take an injected
 * client precisely so that comparison is possible. If you change one side, the
 * drift test fails until you change the other.
 */

// Explicit .ts extension on purpose: webpack resolves it the same way, and it
// is what lets test/webChannelBind.test.js load this module under node --test,
// which has no bundler to guess for it. See allowImportingTsExtensions in
// web/tsconfig.json.
import { displaySafeLabel } from './sanitize.ts';

// ---------------------------------------------------------------------------
// Channel keys. Mirrors lib/channelKey.js.
// ---------------------------------------------------------------------------

export const CHANNELS = {
  WHATSAPP: 'whatsapp',
  TELEGRAM: 'telegram',
  X: 'x',
  GITHUB: 'github',
  DISCORD: 'discord',
} as const;

const KNOWN_CHANNELS = new Set<string>(Object.values(CHANNELS));

/**
 * Channels where an account may hold at most one identity. Chat channels are
 * excluded so a changed WhatsApp LID can still be re-linked alongside the old
 * one. The database says the same thing: channel_identities_account_platform_idx
 * is partial over exactly this set.
 */
const PLATFORM_CHANNELS = new Set<string>([CHANNELS.X, CHANNELS.GITHUB, CHANNELS.DISCORD]);

export function normalizeChannel(raw: unknown): string | null {
  const c = String(raw ?? '').trim().toLowerCase();
  return KNOWN_CHANNELS.has(c) ? c : null;
}

export function isPlatformChannel(raw: unknown): boolean {
  const ch = normalizeChannel(raw);
  return ch !== null && PLATFORM_CHANNELS.has(ch);
}

export function assertChannel(raw: unknown, context = 'channel'): string {
  const ch = normalizeChannel(raw);
  if (!ch) throw new Error(`${context}: unknown channel ${JSON.stringify(String(raw ?? ''))}`);
  return ch;
}

export function normalizeExternalId(raw: unknown): string {
  return String(raw ?? '')
    .split('@')[0]
    .trim()
    .replace(/^\+/, '');
}

// ---------------------------------------------------------------------------
// Lockout ladder. Mirrors lib/lockoutLadder.js.
// ---------------------------------------------------------------------------

const FREE_ATTEMPTS = 4;

const LOCKOUT_LADDER_MS = [
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

export function lockoutMsForAttempts(attempts: number): number {
  const n = Number(attempts) || 0;
  if (n <= FREE_ATTEMPTS) return 0;
  const index = Math.min(n - FREE_ATTEMPTS - 1, LOCKOUT_LADDER_MS.length - 1);
  return LOCKOUT_LADDER_MS[index];
}

export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(Number(ms) / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export function lockStateFrom(until: string | null | undefined) {
  if (!until) return { locked: false, until: null as string | null, remainingMs: 0 };
  const ts = new Date(until).getTime();
  if (!Number.isFinite(ts)) return { locked: false, until: null as string | null, remainingMs: 0 };
  const remainingMs = ts - Date.now();
  if (remainingMs <= 0) return { locked: false, until: null as string | null, remainingMs: 0 };
  return { locked: true, until: new Date(ts).toISOString(), remainingMs };
}

// ---------------------------------------------------------------------------
// The bind core. Mirrors lib/channelBind.js.
// ---------------------------------------------------------------------------

const IDENTITY_TABLE = 'channel_identities';
const EVENTS_TABLE = 'identity_events';
const ATTEMPTS_TABLE = 'identity_bind_attempts';

export const IDENTITY_UNIQUE_INDEX = 'channel_identities_channel_external_idx';
export const ACCOUNT_PLATFORM_UNIQUE_INDEX = 'channel_identities_account_platform_idx';

export const BIND_OUTCOME = {
  LINKED: 'LINKED',
  ALREADY_LINKED: 'ALREADY_LINKED',
  HANDLE_REFRESHED: 'HANDLE_REFRESHED',
  MOVED: 'MOVED',
} as const;

export const IDENTITY_EVENT = {
  LINKED: 'LINKED',
  UNLINKED: 'UNLINKED',
  HANDLE_REFRESHED: 'HANDLE_REFRESHED',
  LINK_REJECTED_ALREADY_TAKEN: 'LINK_REJECTED_ALREADY_TAKEN',
  LINK_REJECTED_ALREADY_LINKED: 'LINK_REJECTED_ALREADY_LINKED',
} as const;

export const REBIND_POLICY = {
  MOVE: 'move',
  REJECT: 'reject',
} as const;

export class BindError extends Error {
  code: string;
  lockedUntil?: string | null;
  retryAfterMs?: number;
  retryAfterText?: string | null;

  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BindError';
    this.code = code;
    Object.assign(this, extra);
  }
}

type AnyClient = {
  from: (table: string) => any;
};

type BindParams = {
  accountId: string;
  channel: string;
  externalId: string;
  displayHandle?: string | null;
  rebindPolicy?: string;
  extraColumns?: Record<string, unknown>;
};

function isUniqueViolation(error: any): boolean {
  return Boolean(error) && String(error.code) === '23505';
}

function violatedIndex(error: any): string {
  const text = `${error?.message || ''} ${error?.details || ''}`;
  if (text.includes(ACCOUNT_PLATFORM_UNIQUE_INDEX)) return ACCOUNT_PLATFORM_UNIQUE_INDEX;
  if (text.includes(IDENTITY_UNIQUE_INDEX)) return IDENTITY_UNIQUE_INDEX;
  return '';
}

function isMissingRelation(error: any): boolean {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === '42P01' || code === 'PGRST205' || /does not exist/i.test(message);
}

export function normalizeDisplayHandle(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim().replace(/^@+/, '');
  const safe = displaySafeLabel(trimmed);
  return safe || null;
}

async function bindLockState(supabase: AnyClient, accountId: string) {
  const open = { locked: false, until: null as string | null, remainingMs: 0, retryAfterText: null as string | null };
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
  return { ...state, retryAfterText: state.locked ? formatWait(state.remainingMs) : null };
}

async function recordRejectedBind(supabase: AnyClient, accountId: string) {
  if (!accountId) return;

  const { data, error: readErr } = await supabase
    .from(ATTEMPTS_TABLE)
    .select('failed_attempts')
    .eq('account_id', accountId)
    .maybeSingle();

  if (readErr && isMissingRelation(readErr)) return;

  const attempts = Number(data?.failed_attempts || 0) + 1;
  const lockedForMs = lockoutMsForAttempts(attempts);

  const patch: Record<string, unknown> = {
    account_id: accountId,
    failed_attempts: attempts,
    last_attempt_at: new Date().toISOString(),
  };
  if (lockedForMs > 0) patch.locked_until = new Date(Date.now() + lockedForMs).toISOString();

  const { error } = await supabase.from(ATTEMPTS_TABLE).upsert(patch, { onConflict: 'account_id' });
  if (error && !isMissingRelation(error)) {
    console.warn(`[bind] attempt write failed: ${error.message}`);
  }
}

async function clearBindAttempts(supabase: AnyClient, accountId: string) {
  if (!accountId) return;
  const { error } = await supabase
    .from(ATTEMPTS_TABLE)
    .update({ failed_attempts: 0, locked_until: null })
    .eq('account_id', accountId);
  if (error && !isMissingRelation(error)) {
    console.warn(`[bind] could not clear attempts: ${error.message}`);
  }
}

async function logIdentityEvent(
  supabase: AnyClient,
  p: { accountId: string; channel: string; externalId: string; displayHandle?: string | null; eventType: string }
) {
  try {
    const { error } = await supabase.from(EVENTS_TABLE).insert({
      account_id: p.accountId || null,
      channel: p.channel,
      external_id: p.externalId,
      display_handle: p.displayHandle || null,
      event_type: p.eventType,
    });
    if (error) {
      if (isMissingRelation(error)) {
        console.warn(
          `[bind] ${EVENTS_TABLE} missing. Identity audit is NOT being written. Run migration 20260802160000_identity_events.sql`
        );
        return;
      }
      console.warn(`[bind] audit write failed (${p.eventType}): ${error.message}`);
    }
  } catch (err: any) {
    console.warn(`[bind] audit write threw (${p.eventType}): ${err.message}`);
  }
}

async function readIdentity(supabase: AnyClient, channel: string, externalId: string) {
  const { data, error } = await supabase
    .from(IDENTITY_TABLE)
    .select('id, account_id, channel, external_id, display_handle, phone_e164')
    .eq('channel', channel)
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) throw new Error(`identity lookup failed: ${error.message}`);
  return data || null;
}

type Ctx = {
  accountId: string;
  channel: string;
  externalId: string;
  displayHandle: string | null;
  rebindPolicy?: string;
  extraColumns: Record<string, unknown>;
};

export async function bindChannelIdentity(supabase: AnyClient, p: BindParams) {
  const accountId = p?.accountId;
  const channel = assertChannel(p?.channel, 'bindChannelIdentity');
  const externalId = normalizeExternalId(p?.externalId);
  const displayHandle = normalizeDisplayHandle(p?.displayHandle);
  const rebindPolicy = p?.rebindPolicy === REBIND_POLICY.MOVE ? REBIND_POLICY.MOVE : REBIND_POLICY.REJECT;
  const extraColumns = p?.extraColumns || {};

  if (!accountId) throw new BindError('INVALID', 'bindChannelIdentity: missing accountId');
  if (!externalId) throw new BindError('INVALID', 'bindChannelIdentity: missing externalId');

  const lock = await bindLockState(supabase, accountId);
  if (lock.locked) {
    throw new BindError('LOCKED', 'Too many rejected links. Try again later.', {
      lockedUntil: lock.until,
      retryAfterMs: lock.remainingMs,
      retryAfterText: lock.retryAfterText,
    });
  }

  const ctx: Ctx = { accountId, channel, externalId, displayHandle, rebindPolicy, extraColumns };

  const existing = await readIdentity(supabase, channel, externalId);
  if (existing) {
    if (existing.account_id === accountId) return refreshOwnIdentity(supabase, existing, ctx);
    return resolveCrossAccount(supabase, existing, ctx);
  }

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
      return rejectAlreadyLinked(supabase, ctx);
    }
  }

  const row: Record<string, unknown> = {
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
    await logIdentityEvent(supabase, { ...ctx, eventType: IDENTITY_EVENT.LINKED });
    return { outcome: BIND_OUTCOME.LINKED, identity: inserted };
  }

  if (!isUniqueViolation(insertErr)) {
    throw new Error(`identity bind failed: ${insertErr.message}`);
  }

  if (violatedIndex(insertErr) === ACCOUNT_PLATFORM_UNIQUE_INDEX) {
    return rejectAlreadyLinked(supabase, ctx);
  }

  const raced = await readIdentity(supabase, channel, externalId);
  if (!raced) {
    throw new Error('identity bind failed: unique violation with no row to resolve');
  }
  if (raced.account_id === accountId) return refreshOwnIdentity(supabase, raced, ctx);
  return resolveCrossAccount(supabase, raced, ctx);
}

async function refreshOwnIdentity(supabase: AnyClient, existing: any, ctx: Ctx) {
  const patch: Record<string, unknown> = { ...ctx.extraColumns };
  const handleChanged = Boolean(ctx.displayHandle) && ctx.displayHandle !== existing.display_handle;
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
    await logIdentityEvent(supabase, { ...ctx, eventType: IDENTITY_EVENT.HANDLE_REFRESHED });
    return { outcome: BIND_OUTCOME.HANDLE_REFRESHED, identity };
  }
  return { outcome: BIND_OUTCOME.ALREADY_LINKED, identity };
}

async function resolveCrossAccount(supabase: AnyClient, existing: any, ctx: Ctx) {
  if (ctx.rebindPolicy !== REBIND_POLICY.MOVE) {
    await recordRejectedBind(supabase, ctx.accountId);
    await logIdentityEvent(supabase, { ...ctx, eventType: IDENTITY_EVENT.LINK_REJECTED_ALREADY_TAKEN });
    throw new BindError('IDENTITY_TAKEN', 'That account is already linked to another Flizy account.');
  }

  const patch: Record<string, unknown> = {
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
  await logIdentityEvent(supabase, { ...ctx, eventType: IDENTITY_EVENT.LINKED });
  return { outcome: BIND_OUTCOME.MOVED, identity: data || existing };
}

async function rejectAlreadyLinked(supabase: AnyClient, ctx: Ctx) {
  await recordRejectedBind(supabase, ctx.accountId);
  await logIdentityEvent(supabase, { ...ctx, eventType: IDENTITY_EVENT.LINK_REJECTED_ALREADY_LINKED });
  throw new BindError(
    'ALREADY_LINKED_DIFFERENT',
    'This account already has a different one linked. Unlink it first.'
  );
}

/**
 * Remove an identity (platform or chat: whatsapp / telegram / github / …).
 * Site callers re-check password; chat can unlink the current channel only.
 */
export async function unlinkChannelIdentity(
  supabase: AnyClient,
  p: { accountId: string; channel: string }
) {
  const ch = assertChannel(p?.channel, 'unlinkChannelIdentity');
  if (!p?.accountId) throw new BindError('INVALID', 'unlinkChannelIdentity: missing accountId');

  const { data: rows, error } = await supabase
    .from(IDENTITY_TABLE)
    .delete()
    .eq('account_id', p.accountId)
    .eq('channel', ch)
    .select('*');
  if (error) throw new Error(`identity unlink failed: ${error.message}`);

  const removed = rows || [];
  for (const row of removed) {
    await logIdentityEvent(supabase, {
      accountId: p.accountId,
      channel: ch,
      externalId: row.external_id,
      displayHandle: row.display_handle,
      eventType: IDENTITY_EVENT.UNLINKED,
    });
  }
  return { removed: removed.length, identities: removed };
}
