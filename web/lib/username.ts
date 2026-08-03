/**
 * Flizy-native @username (web mirror of lib/username.js).
 *
 * Recognition only — never a payment routing key. Keep rules in sync with
 * the bot; test/username.test.js and a drift check cover both sides.
 */

import { displaySafeLabel } from './sanitize.ts';

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
  if (!/^[a-z][a-z0-9_]*$/.test(u)) {
    return {
      ok: false,
      error: 'Username must start with a letter and use only letters, numbers, underscore.',
    };
  }
  if (RESERVED.has(u)) {
    return { ok: false, error: 'That username is reserved.' };
  }
  return { ok: true, username: u };
}

/** Public label for UI: @name when set. */
export function formatUsernameLabel(username: unknown): string | null {
  const u = normalizeUsername(username || '');
  if (!u) return null;
  return `@${displaySafeLabel(u)}`;
}

export { RESERVED };
