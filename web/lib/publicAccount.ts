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

export type AccountRow = {
  id?: string;
  email?: string | null;
  display_name?: string | null;
  agent_wallet_address?: string | null;
  balance_eth?: number | string | null;
  unlock_pin_hash?: string | null;
  password_hash?: string | null;
  daily_send_limit_eth?: number | string | null;
};

export type PublicAccount = {
  email?: string | null;
  display_name?: string | null;
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
  if ('display_name' in row) out.display_name = row.display_name ?? null;
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
