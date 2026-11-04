import { randomBytes } from 'crypto';
import { bearerApiKey, apiKeyMode, hashApiKey, type ApiMode, type ApiScope } from './apiKeys.ts';
import { clientIp, clientIpKey } from './clientIp.ts';

/**
 * Authentication, permissions and rate limits for /api/v1.
 *
 * Every failure to prove who is calling gets the same 401, whatever the reason
 * (no header, a malformed key, an unknown key, a revoked key, a disabled
 * platform, a key from the other mode), so a caller cannot probe which keys or
 * platforms exist. A known key without the permission a route needs, or called
 * from an address its allowlist does not name, gets 403.
 *
 * Each authenticated call is logged in api_requests, which is also the rate
 * limit's counter. The database is passed in, so tests can drive it.
 */

/** Calls per key per minute. */
export const RATE_PER_MINUTE = 120;

type DbError = { code?: string; message?: string } | null;
type Query = PromiseLike<{ data: unknown; error: DbError; count?: number | null }> & {
  select(cols: string, opts?: { count?: 'exact'; head?: boolean }): Query;
  insert(values: Record<string, unknown>): Query;
  update(values: Record<string, unknown>): Query;
  eq(col: string, value: unknown): Query;
  gte(col: string, value: unknown): Query;
  maybeSingle(): PromiseLike<{ data: unknown; error: DbError }>;
};
export type ApiDb = { from: (table: string) => unknown };
// One helper per table: the names stay literal so the schema guard can see them.
const keysTable = (db: ApiDb) => db.from('api_keys') as Query;
const platformsTable = (db: ApiDb) => db.from('api_platforms') as Query;
const requestsTable = (db: ApiDb) => db.from('api_requests') as Query;
const controlTable = (db: ApiDb) => db.from('api_control') as Query;

export type ApiCaller = {
  requestId: string;
  keyId: string;
  platformId: string;
  platformName: string;
  walletAddress: string;
  mode: ApiMode;
  scopes: ApiScope[];
  prefix: string;
};

type KeyRow = {
  id: string;
  platform_id: string;
  mode: ApiMode;
  prefix: string;
  scopes: ApiScope[];
  ip_allowlist: string[] | null;
  revoked_at: string | null;
};
type PlatformRow = { id: string; display_name: string; wallet_address: string; enabled: boolean };

export function newRequestId(): string {
  return `req_${randomBytes(12).toString('base64url')}`;
}

/** The one error shape, with the request id in the body and the header. */
export function apiError(status: number, code: string, message: string, requestId: string): Response {
  return Response.json(
    { error: { code, message, request_id: requestId } },
    { status, headers: { 'X-Request-Id': requestId, 'Cache-Control': 'no-store' } }
  );
}

export function apiJson(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, { status, headers: { 'X-Request-Id': requestId, 'Cache-Control': 'no-store' } });
}

/** The mode this deployment serves. Only `test` keys work until mainnet sets `live`. */
export function serverApiMode(env: Record<string, string | undefined> = process.env): ApiMode {
  return env.FLIZY_API_MODE === 'live' ? 'live' : 'test';
}

/**
 * Both halves of the global payout switch must be on: API_PAYOUTS_ENABLED in
 * the environment (needs a deploy to change) and api_control.payouts_enabled in
 * the database (changed instantly by Flizy). Either one off stops every API
 * payout. An unreadable control row counts as off.
 */
export async function payoutsEnabled(db: ApiDb, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (env.API_PAYOUTS_ENABLED !== 'true') return false;
  const { data, error } = await controlTable(db).select('payouts_enabled').eq('id', true).maybeSingle();
  if (error || !data) return false;
  return (data as { payouts_enabled?: boolean }).payouts_enabled === true;
}

type AuthResult = { ok: true; caller: ApiCaller } | { ok: false; response: Response };

const UNAUTHORIZED = 'Missing or invalid API key.';

export async function authenticateApiRequest(
  req: Request,
  db: ApiDb,
  need: ApiScope,
  opts: { env?: Record<string, string | undefined>; now?: number } = {}
): Promise<AuthResult> {
  const requestId = newRequestId();
  const deny = (status: number, code: string, message: string): AuthResult => ({
    ok: false,
    response: apiError(status, code, message, requestId),
  });

  const secret = bearerApiKey(req.headers.get('authorization'));
  if (!secret || apiKeyMode(secret) !== serverApiMode(opts.env)) return deny(401, 'unauthorized', UNAUTHORIZED);

  const { data: keyData, error: keyErr } = await keysTable(db)
    .select('id, platform_id, mode, prefix, scopes, ip_allowlist, revoked_at')
    .eq('key_hash', hashApiKey(secret))
    .maybeSingle();
  if (keyErr) return deny(503, 'unavailable', 'Try again shortly.');
  const key = keyData as KeyRow | null;
  if (!key || key.revoked_at) return deny(401, 'unauthorized', UNAUTHORIZED);

  const { data: platData, error: platErr } = await platformsTable(db)
    .select('id, display_name, wallet_address, enabled')
    .eq('id', key.platform_id)
    .maybeSingle();
  if (platErr) return deny(503, 'unavailable', 'Try again shortly.');
  const platform = platData as PlatformRow | null;
  if (!platform || !platform.enabled) return deny(401, 'unauthorized', UNAUTHORIZED);

  const allow = (key.ip_allowlist || []).map((ip) => ip.toLowerCase());
  if (allow.length && !allow.includes(clientIp(req.headers).toLowerCase())) {
    return deny(403, 'ip_not_allowed', 'This key cannot be used from this address.');
  }
  if (!(key.scopes || []).includes(need)) {
    return deny(403, 'permission_denied', `This key does not have the ${need} permission.`);
  }

  // Rate limit: calls by this key in the last minute, from the request log.
  const since = new Date((opts.now ?? Date.now()) - 60_000).toISOString();
  const { count, error: countErr } = await requestsTable(db)
    .select('id', { count: 'exact', head: true })
    .eq('key_id', key.id)
    .gte('created_at', since);
  if (countErr) return deny(503, 'unavailable', 'Try again shortly.');
  if ((count ?? 0) >= RATE_PER_MINUTE) return deny(429, 'rate_limited', 'Too many requests. Slow down and retry.');

  return {
    ok: true,
    caller: {
      requestId,
      keyId: key.id,
      platformId: platform.id,
      platformName: platform.display_name,
      walletAddress: platform.wallet_address,
      mode: key.mode,
      scopes: key.scopes,
      prefix: key.prefix,
    },
  };
}

/** One row per authenticated call, the audit trail and the rate counter. Never blocks the answer. */
export async function logApiRequest(
  db: ApiDb,
  req: Request,
  caller: ApiCaller,
  status: number,
  idempotencyKey: string | null = null
): Promise<void> {
  try {
    const url = new URL(req.url);
    await requestsTable(db).insert({
      request_id: caller.requestId,
      key_id: caller.keyId,
      platform_id: caller.platformId,
      method: req.method,
      path: url.pathname.slice(0, 200),
      status,
      idempotency_key: idempotencyKey,
      ip_key: clientIpKey(req.headers),
    });
    await keysTable(db).update({ last_used_at: new Date().toISOString() }).eq('id', caller.keyId);
  } catch {
    // The log is best effort; the answer has already been decided.
  }
}
