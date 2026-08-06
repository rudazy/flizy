/**
 * The one place that decides which account fields may leave the server.
 *
 * This is a whitelist, never a spread of the DB row. Two things must never
 * reach the browser: the secret hashes (password_hash, unlock_pin_hash) and the
 * account id. The id is not merely an internal identifier, it is an input to
 * the agent wallet derivation, so shipping it in a response body widens the
 * blast radius of any XSS, log capture, or analytics payload.
 *
 * Only keys actually selected by the caller are emitted, so each route keeps
 * the response shape it had before, minus the id.
 */

import { usernameChangeWindow } from './username.ts';
import { normalizeLocale, type LocaleCode } from './locale.ts';

export type AccountRow = {
  id?: string;
  email?: string | null;
  email_verified_at?: string | null;
  display_name?: string | null;
  /** Flizy @username (recognition only; not a payment key) */
  username?: string | null;
  username_changed_at?: string | null;
  locale?: string | null;
  agent_wallet_address?: string | null;
  balance_eth?: number | string | null;
  unlock_pin_hash?: string | null;
  password_hash?: string | null;
  daily_send_limit_eth?: number | string | null;
};

export type PublicAccount = {
  email?: string | null;
  /** True when registration email was proven with a one-time code */
  email_verified?: boolean;
  display_name?: string | null;
  /** Canonical lowercase username without @, or null */
  username?: string | null;
  /** false while inside the 30-day rename window */
  can_change_username?: boolean;
  /** ISO time when rename is allowed again; null if now */
  username_next_change_at?: string | null;
  /** UI language: en | ko | zh */
  locale?: LocaleCode;
  agent_wallet_address?: string | null;
  balance_eth?: number | string;
  has_pin?: boolean;
  daily_send_limit_eth?: number | string | null;
};

/**
 * @param row raw accounts row (may contain secrets; they are dropped here)
 */
export function toPublicAccount(row: AccountRow | null | undefined): PublicAccount {
  const out: PublicAccount = {};
  if (!row) return out;

  if ('email' in row) out.email = row.email ?? null;
  if ('email' in row || 'email_verified_at' in row) {
    out.email_verified = Boolean(row.email_verified_at);
  }
  if ('display_name' in row) out.display_name = row.display_name ?? null;
  if ('username' in row) {
    const u = row.username == null ? null : String(row.username).trim().toLowerCase();
    out.username = u || null;
  }
  if ('username' in row || 'username_changed_at' in row) {
    const win = usernameChangeWindow(row.username, row.username_changed_at ?? null);
    out.can_change_username = win.canChangeUsername;
    out.username_next_change_at = win.usernameNextChangeAt;
  }
  if ('locale' in row) {
    out.locale = normalizeLocale(row.locale);
  }
  if ('agent_wallet_address' in row) out.agent_wallet_address = row.agent_wallet_address ?? null;
  if ('balance_eth' in row) out.balance_eth = row.balance_eth ?? 0;
  // Presence of a PIN is safe to expose; the hash never is.
  if ('unlock_pin_hash' in row) out.has_pin = Boolean(row.unlock_pin_hash);
  if ('daily_send_limit_eth' in row) {
    out.daily_send_limit_eth =
      row.daily_send_limit_eth === null || row.daily_send_limit_eth === undefined
        ? null
        : row.daily_send_limit_eth;
  }

  return out;
}
