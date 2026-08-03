/**
 * Flizy-native @username (web mirror of lib/username.js).
 *
 * ASCII a-z / 0-9 only. No underscore. Not Hangul/Han (use display_name).
 * Change at most once every 30 days. Keep in sync with bot; tests cover drift.
 */

import { displaySafeLabel } from './sanitize.ts';

/** 30 days in ms */
export const USERNAME_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

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

export function normalizeUsername(raw: unknown): string {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

export type UsernameValidation =
  | { ok: true; username: string }
  | { ok: false; error: string };

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
  if (RESERVED.has(u)) {
    return { ok: false, error: 'That username is reserved.' };
  }
  return { ok: true, username: u };
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

export { RESERVED };
