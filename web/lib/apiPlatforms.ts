import { generateApiKey, type ApiMode, type ApiScope } from './apiKeys.ts';
import { displaySafeLabel } from './sanitize.ts';

/**
 * The approved platform behind a Flizy account, and its API keys, for the
 * Developers section of Account.
 *
 * A platform exists only when Flizy approved it (scripts/api-platform.mjs);
 * nothing here creates one. Keys are created with `read` and `collect` at most;
 * `payout` is granted by Flizy alone. A key is always looked up through its
 * platform, so a session can only ever touch its own platform's keys.
 *
 * Every key change is recorded by the database trigger in api_key_events and
 * mailed to the owner (mailKeyEvents), including changes Flizy makes directly
 * in the database. The database and the mailer are passed in, so tests can
 * drive this without either.
 */

type DbError = { code?: string; message?: string } | null;
type Query = PromiseLike<{ data: unknown; error: DbError }> & {
  select(cols: string): Query;
  insert(values: Record<string, unknown>): Query;
  update(values: Record<string, unknown>): Query;
  eq(col: string, value: unknown): Query;
  is(col: string, value: null): Query;
  order(col: string, opts: { ascending: boolean }): Query;
  limit(n: number): Query;
  single(): PromiseLike<{ data: unknown; error: DbError }>;
  maybeSingle(): PromiseLike<{ data: unknown; error: DbError }>;
};
export type PlatformDb = { from: (table: string) => unknown };
function platforms(db: PlatformDb): Query {
  return db.from('api_platforms') as Query;
}
function keys(db: PlatformDb): Query {
  return db.from('api_keys') as Query;
}
function keyEvents(db: PlatformDb): Query {
  return db.from('api_key_events') as Query;
}

export type Platform = {
  id: string;
  account_id: string;
  display_name: string;
  wallet_address: string;
  enabled: boolean;
  fee_bps: number;
  claim_expiry_default_days: number;
  claim_expiry_max_days: number;
};

export type KeyView = {
  id: string;
  label: string;
  prefix: string;
  mode: ApiMode;
  scopes: ApiScope[];
  ipAllowlist: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

const PLATFORM_COLS = 'id, account_id, display_name, wallet_address, enabled, fee_bps, claim_expiry_default_days, claim_expiry_max_days';
const KEY_COLS = 'id, label, prefix, mode, scopes, ip_allowlist, created_at, last_used_at, revoked_at';
/** Live keys a platform may hold at once. The api_keys_cap trigger enforces the same number. */
export const MAX_ACTIVE_KEYS = 10;
/** check_violation, raised by the api_keys_cap trigger. */
const KEY_CAP_CODE = '23514';
/** unique_violation: a key that was already rotated (api_keys_cap trigger, backed by api_keys_rotated_from_idx). */
const UNIQUE_CODE = '23505';

export async function platformForAccount(db: PlatformDb, accountId: string): Promise<Platform | null> {
  const { data, error } = await platforms(db).select(PLATFORM_COLS).eq('account_id', accountId).maybeSingle();
  if (error) throw new Error(error.message || 'platform read failed');
  return (data as Platform | null) ?? null;
}

function toView(row: Record<string, unknown>): KeyView {
  return {
    id: String(row.id),
    label: String(row.label || ''),
    prefix: String(row.prefix || ''),
    mode: row.mode === 'live' ? 'live' : 'test',
    scopes: (Array.isArray(row.scopes) ? row.scopes : []) as ApiScope[],
    ipAllowlist: Array.isArray(row.ip_allowlist) ? (row.ip_allowlist as string[]) : [],
    createdAt: String(row.created_at || ''),
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    revokedAt: (row.revoked_at as string | null) ?? null,
  };
}

export async function listKeys(db: PlatformDb, platformId: string): Promise<KeyView[]> {
  const { data, error } = await keys(db).select(KEY_COLS).eq('platform_id', platformId).order('created_at', { ascending: false }).limit(50);
  if (error) throw new Error(error.message || 'key read failed');
  return ((data as Record<string, unknown>[]) || []).map(toView);
}

export class KeyRequestError extends Error {}

/** A new key. The secret is returned once, to show once; only its digest is stored. */
export async function createKey(
  db: PlatformDb,
  platform: Platform,
  input: { label: string; scopes: ApiScope[]; ipAllowlist: string[]; mode: ApiMode; rotatedFrom?: string | null }
): Promise<{ key: KeyView; secret: string }> {
  if (input.scopes.includes('payout')) throw new KeyRequestError('Payout permission is granted by Flizy, not here.');
  const active = (await listKeys(db, platform.id)).filter((k) => !k.revokedAt).length;
  if (active >= MAX_ACTIVE_KEYS) throw new KeyRequestError(`A platform can hold ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
  const made = generateApiKey(input.mode);
  const { data, error } = await keys(db)
    .insert({
      platform_id: platform.id,
      mode: input.mode,
      prefix: made.prefix,
      key_hash: made.hash,
      label: displaySafeLabel(input.label, 60),
      scopes: input.scopes,
      ip_allowlist: input.ipAllowlist.length ? input.ipAllowlist : null,
      rotated_from: input.rotatedFrom ?? null,
    })
    .select(KEY_COLS)
    .single();
  // The database trigger holds the cap when two creates race past the count above.
  if (error?.code === KEY_CAP_CODE) throw new KeyRequestError(`A platform can hold ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
  if (error || !data) throw new Error(error?.message || 'key insert failed');
  return { key: toView(data as Record<string, unknown>), secret: made.secret };
}

async function ownKey(db: PlatformDb, platform: Platform, keyId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await keys(db)
    .select(`${KEY_COLS}, platform_id`)
    .eq('id', keyId)
    .eq('platform_id', platform.id)
    .maybeSingle();
  if (error) throw new Error(error.message || 'key read failed');
  return (data as Record<string, unknown> | null) ?? null;
}

/** Revoke one key, now. Others are untouched. False when it is not this platform's or already revoked. */
export async function revokeKey(db: PlatformDb, platform: Platform, keyId: string): Promise<boolean> {
  const row = await ownKey(db, platform, keyId);
  if (!row || row.revoked_at) return false;
  const { error } = await keys(db)
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .eq('platform_id', platform.id)
    .is('revoked_at', null);
  if (error) throw new Error(error.message || 'key revoke failed');
  return true;
}

/**
 * Replace one key: a new key with the same label, permissions and allowlist,
 * then the old one revoked. Other keys are untouched. The new secret is shown
 * once. A payout permission carries over only because Flizy granted it to the
 * old key; this path never adds one. A key can be rotated once: the unique
 * index on rotated_from refuses a second new key from the same old one, so two
 * rotations at once cannot leave two live copies of its permissions.
 */
export async function rotateKey(
  db: PlatformDb,
  platform: Platform,
  keyId: string
): Promise<{ key: KeyView; secret: string } | null> {
  const row = await ownKey(db, platform, keyId);
  if (!row || row.revoked_at) return null;
  const old = toView(row);
  const made = generateApiKey(old.mode);
  const { data, error } = await keys(db)
    .insert({
      platform_id: platform.id,
      mode: old.mode,
      prefix: made.prefix,
      key_hash: made.hash,
      label: old.label,
      scopes: old.scopes,
      ip_allowlist: old.ipAllowlist.length ? old.ipAllowlist : null,
      rotated_from: old.id,
    })
    .select(KEY_COLS)
    .single();
  if (error?.code === UNIQUE_CODE) return null;
  if (error || !data) throw new Error(error?.message || 'key insert failed');
  await revokeKey(db, platform, keyId);
  return { key: toView(data as Record<string, unknown>), secret: made.secret };
}

/** The email for one key event. Names only the key's prefix, never the secret. */
export function keyEventMail(
  siteUrl: string,
  event: { kind: string; scopes: string[] | null; created_at: string },
  key: { prefix: string; label: string },
  platformName: string
): { subject: string; text: string } {
  const name = displaySafeLabel(platformName, 60) || 'your platform';
  const which = `${key.prefix}...${key.label ? ` (${displaySafeLabel(key.label, 60)})` : ''}`;
  const when = new Date(event.created_at).toUTCString();
  const scopes = (event.scopes || []).join(', ') || 'none';
  const line =
    event.kind === 'created'
      ? `A new API key was created for ${name}: ${which}, permissions ${scopes}.`
      : event.kind === 'revoked'
        ? `An API key for ${name} was revoked: ${which}. It no longer works.`
        : `The permissions of an API key for ${name} changed: ${which}, now ${scopes}.`;
  return {
    subject: event.kind === 'created' ? 'New Flizy API key' : event.kind === 'revoked' ? 'Flizy API key revoked' : 'Flizy API key permissions changed',
    text: [
      line,
      `Time: ${when}`,
      '',
      `If this was not you, revoke the key in Account, Developers: ${siteUrl.replace(/\/$/, '')}/dashboard/account?s=developers`,
      'and change your password.',
    ].join('\n'),
  };
}

/**
 * Mail every key event not yet mailed, for one platform or all, oldest first,
 * at most `limit`. Each event is claimed (mailed_at set where it is still null)
 * before it is sent, so two runs at once never mail it twice; a failed send
 * clears the claim and the next run retries. Returns how many went out.
 */
export async function mailKeyEvents(
  db: PlatformDb,
  mail: (accountId: string, body: { subject: string; text: string }) => Promise<boolean>,
  siteUrl: string,
  opts: { platformId?: string; limit?: number } = {}
): Promise<number> {
  let query = keyEvents(db).select('id, key_id, platform_id, kind, scopes, created_at').is('mailed_at', null);
  if (opts.platformId) query = query.eq('platform_id', opts.platformId);
  const { data, error } = await query.order('created_at', { ascending: true }).limit(opts.limit ?? 50);
  if (error) throw new Error(error.message || 'key event read failed');
  let sent = 0;
  for (const ev of (data as Array<{ id: string; key_id: string; platform_id: string; kind: string; scopes: string[] | null; created_at: string }>) || []) {
    const { data: plat } = await platforms(db).select('account_id, display_name').eq('id', ev.platform_id).maybeSingle();
    const { data: key } = await keys(db).select('prefix, label').eq('id', ev.key_id).maybeSingle();
    if (!plat || !key) continue;
    const p = plat as { account_id: string; display_name: string };
    const k = key as { prefix: string; label: string };
    const { data: claimed } = await keyEvents(db)
      .update({ mailed_at: new Date().toISOString() })
      .eq('id', ev.id)
      .is('mailed_at', null)
      .select('id');
    if (!Array.isArray(claimed) || claimed.length === 0) continue;
    const ok = await mail(p.account_id, keyEventMail(siteUrl, ev, k, p.display_name)).catch(() => false);
    if (!ok) {
      await keyEvents(db).update({ mailed_at: null }).eq('id', ev.id);
      continue;
    }
    sent += 1;
  }
  return sent;
}
