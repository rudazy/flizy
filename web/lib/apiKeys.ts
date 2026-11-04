import { createHash, randomBytes } from 'crypto';

/**
 * Flizy Pay API keys.
 *
 * A key is a prefix that names its mode and 32 random bytes: `fz_test_` or
 * `fz_live_` and 43 base64url characters. It is shown to the platform once and
 * stored only as the SHA-256 of the whole string; with 256 bits of randomness a
 * plain digest is enough to make the stored value useless to a reader. The
 * lookup is by that digest, so no key string is ever compared or kept.
 *
 * Permissions: `read`, `collect`, `payout`. The site grants `read` and `collect`
 * only. `payout` is turned on per key by Flizy (scripts/api-platform.mjs), so
 * no session, however obtained, can give itself the power to send money.
 *
 * Imports only crypto, so node --test loads this file directly.
 */

export const API_MODES = ['test', 'live'] as const;
export type ApiMode = (typeof API_MODES)[number];

export const KEY_PREFIX: Readonly<Record<ApiMode, string>> = { test: 'fz_test_', live: 'fz_live_' };

export const API_SCOPES = ['read', 'collect', 'payout'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** What a platform may give its own keys from the Developers page. */
export const SITE_GRANTABLE_SCOPES: readonly ApiScope[] = ['read', 'collect'];

const KEY_RE = /^fz_(test|live)_[A-Za-z0-9_-]{43}$/;

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A new key: the secret to show once, the part safe to show again, and the digest to store. */
export function generateApiKey(mode: ApiMode): { secret: string; prefix: string; hash: string } {
  const secret = `${KEY_PREFIX[mode]}${randomBytes(32).toString('base64url')}`;
  return { secret, prefix: secret.slice(0, KEY_PREFIX[mode].length + 6), hash: hashApiKey(secret) };
}

/** The mode a well-formed key claims, or null for anything that is not a Flizy key. */
export function apiKeyMode(raw: string): ApiMode | null {
  const m = KEY_RE.exec(String(raw || ''));
  return m ? (m[1] as ApiMode) : null;
}

/** The key from an `Authorization: Bearer ...` header, or null. */
export function bearerApiKey(header: string | null): string | null {
  const m = /^Bearer ([^\s]+)$/.exec(String(header || '').trim());
  return m && apiKeyMode(m[1]) ? m[1] : null;
}

/**
 * Permissions a request may set, from what it sent: known names only, no
 * duplicates, at least one, and only from `allowed`. Null when the request asks
 * for anything else, rather than silently dropping it.
 */
export function cleanScopes(raw: unknown, allowed: readonly ApiScope[] = SITE_GRANTABLE_SCOPES): ApiScope[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = new Set<ApiScope>();
  for (const s of raw) {
    if (typeof s !== 'string' || !(allowed as readonly string[]).includes(s)) return null;
    out.add(s as ApiScope);
  }
  return API_SCOPES.filter((s) => out.has(s));
}

/**
 * An IP allowlist from what the platform typed: exact IPv4 or IPv6 addresses,
 * at most 20. Empty means no allowlist. Null when an entry is not an address.
 */
export function cleanIpAllowlist(raw: unknown): string[] | null {
  if (raw == null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[\s,]+/);
  const out: string[] = [];
  for (const item of list) {
    const ip = String(item || '').trim();
    if (!ip) continue;
    const v4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(ip);
    const v6 = /^[0-9a-fA-F:]{2,39}$/.test(ip) && ip.includes(':');
    if (!v4 && !v6) return null;
    if (!out.includes(ip.toLowerCase())) out.push(ip.toLowerCase());
  }
  return out.length > 20 ? null : out;
}
