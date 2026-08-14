/**
 * Flizy-native @username (web mirror of lib/username.js).
 *
 * Recognition, invite, and public pay identity.
 * ASCII a-z / 0-9 only. No underscore. Not Hangul/Han (use display_name).
 * Change at most once every 30 days. Reserved names live in the DB, matched
 * on reservedKey. Keep in sync with bot; tests cover drift.
 */

import { displaySafeLabel } from './sanitize.ts';

/** 30 days in ms */
export const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Client-facing copy for reserved and taken (identical on purpose). */
export const USERNAME_UNAVAILABLE = 'That username is unavailable.';

export function normalizeUsername(raw: unknown): string {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

/**
 * Key used for reserved-name lookup and storage.
 * Seeds store reservedKey(name); lookup always uses the same function.
 * support / supportt both become suport after collapse of repeated chars.
 */
export function reservedKey(raw: unknown): string {
  let u = normalizeUsername(raw);
  u = u.replace(/[^a-z0-9]/g, '');
  u = u.replace(/(.)\1+/g, '$1');
  return u;
}

export type UsernameValidation =
  | { ok: true; username: string }
  | { ok: false; error: string };

/** Format-only. Reserved check is separate (DB or injected set). */
export function validateUsername(raw: unknown): UsernameValidation {
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
  if (!/^[a-z][a-z0-9]*$/.test(u)) {
    return {
      ok: false,
      error: 'Username must start with a letter and use only letters and numbers (a-z, 0-9).',
    };
  }
  return { ok: true, username: u };
}

export function isReservedAgainst(
  raw: unknown,
  reservedKeys: Set<string> | Iterable<string>
): boolean {
  const key = reservedKey(raw);
  if (!key) return false;
  if (reservedKeys instanceof Set) return reservedKeys.has(key);
  return new Set(reservedKeys).has(key);
}

/** Shape of the one row this lookup reads. */
type ReservedRow = { normalized_name?: string | null };

/** Shape of the maybeSingle() envelope, re-asserted below. */
type ReservedLookup = {
  data: ReservedRow | null;
  error: { message?: string } | null;
};

/**
 * Minimal client shape. `from` returns unknown on purpose.
 *
 * Spelling out the full select/eq/maybeSingle chain here forces tsc to check
 * SupabaseClient against it structurally, and supabase-js parses the select
 * string at the type level (GetResult<...>), so that check recurses until the
 * compiler bails with "Type instantiation is excessively deep and possibly
 * infinite" at the CALL SITE. That is a build failure, not a runtime bug.
 * Returning unknown makes the check trivial; the chain is typed below instead.
 */
type SupabaseLike = {
  from: (table: string) => unknown;
};

/** Query reserved_usernames. Throws on DB error (fail closed at the route). */
export async function isUsernameReserved(
  supabase: SupabaseLike,
  raw: unknown
): Promise<boolean> {
  const key = reservedKey(raw);
  if (!key) return false;
  const query = supabase.from('reserved_usernames') as {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => Promise<ReservedLookup>;
      };
    };
  };
  const { data, error } = await query
    .select('normalized_name')
    .eq('normalized_name', key)
    .maybeSingle();
  if (error) {
    const err = new Error(`reserved_usernames lookup failed: ${error.message || error}`);
    throw err;
  }
  return Boolean(data && data.normalized_name);
}

export function formatUsernameLabel(username: unknown): string | null {
  const u = normalizeUsername(username || '');
  if (!u) return null;
  return `@${displaySafeLabel(u)}`;
}

export type UsernameChangeAllowed =
  | { ok: true; isNoop: boolean }
  | { ok: false; error: string; nextChangeAt: string };

export function assertUsernameChangeAllowed(p: {
  currentUsername?: string | null;
  usernameChangedAt?: string | Date | null;
  nextUsername: string;
  now?: Date;
}): UsernameChangeAllowed {
  const next = normalizeUsername(p.nextUsername);
  const current = normalizeUsername(p.currentUsername || '');
  const now = p.now || new Date();

  if (current && current === next) {
    return { ok: true, isNoop: true };
  }
  if (!current) {
    return { ok: true, isNoop: false };
  }
  if (!p.usernameChangedAt) {
    return { ok: true, isNoop: false };
  }
  const lastMs = new Date(p.usernameChangedAt).getTime();
  if (!Number.isFinite(lastMs)) {
    return { ok: true, isNoop: false };
  }
  const nextMs = lastMs + USERNAME_CHANGE_COOLDOWN_MS;
  if (now.getTime() >= nextMs) {
    return { ok: true, isNoop: false };
  }
  const nextChangeAt = new Date(nextMs).toISOString();
  const when = new Date(nextChangeAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return {
    ok: false,
    error: `You can change your username again after ${when}.`,
    nextChangeAt,
  };
}

export function usernameChangeWindow(
  username: string | null | undefined,
  usernameChangedAt: string | Date | null | undefined,
  now: Date = new Date()
): { canChangeUsername: boolean; usernameNextChangeAt: string | null } {
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
