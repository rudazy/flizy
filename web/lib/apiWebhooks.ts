import { randomUUID } from 'crypto';
import { displaySafeLabel } from './sanitize.ts';
import { encryptWebhookSecret, generateWebhookSecret, webhookKey, WebhookKeyMissing } from './apiWebhookSecret.ts';
import type { Platform } from './apiPlatforms.ts';

/**
 * Flizy Pay API webhook endpoints and their deliveries, for the Developers
 * page.
 *
 * An endpoint is a platform's https URL. Its secret is shown once and stored
 * only encrypted (web/lib/apiWebhookSecret.ts); the VPS worker
 * (lib/api/webhookWorker.js) signs and delivers each event to it, and only to
 * a public address: registration takes a host name, never an IP address, and
 * the worker checks what that name resolves to at every delivery. A platform
 * may keep MAX_ENDPOINTS endpoints. A delivery that failed can be sent again
 * from the page.
 *
 * The database is passed in, so tests can drive this.
 */

export const MAX_ENDPOINTS = 5;
/** Every event a payout can produce, as api_transition writes them. */
export const WEBHOOK_EVENTS = [
  'payout.queued',
  'payout.submitted',
  'payout.confirmed',
  'payout.claim_pending',
  'payout.failed',
  'payout.expired',
  'payout.refund_pending',
  'payout.refunded',
] as const;

export class WebhookRequestError extends Error {}

type DbError = { code?: string; message?: string } | null;
type Query = PromiseLike<{ data: unknown; error: DbError }> & {
  select(cols: string): Query;
  insert(values: Record<string, unknown>): Query;
  update(values: Record<string, unknown>): Query;
  delete(): Query;
  eq(col: string, value: unknown): Query;
  in(col: string, values: unknown[]): Query;
  order(col: string, opts: { ascending: boolean }): Query;
  limit(n: number): Query;
  single(): PromiseLike<{ data: unknown; error: DbError }>;
};
type WebhookDb = { from: (table: string) => unknown };
const endpoints = (db: WebhookDb) => db.from('api_webhook_endpoints') as Query;
const deliveries = (db: WebhookDb) => db.from('api_webhook_deliveries') as Query;
const events = (db: WebhookDb) => db.from('api_webhook_events') as Query;

/** The URL a platform may register: https, a host name, port 443, no user or password. */
export function cleanWebhookUrl(raw: unknown): string {
  const s = String(raw ?? '').trim();
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new WebhookRequestError('Enter a full https URL.');
  }
  if (s.length > 2000) throw new WebhookRequestError('The URL is too long.');
  if (url.protocol !== 'https:') throw new WebhookRequestError('Webhooks are sent over https only.');
  if (url.username || url.password) throw new WebhookRequestError('The URL must not carry a user name or password.');
  if (url.port && url.port !== '443') throw new WebhookRequestError('Webhooks are sent to port 443 only.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[0-9.]+$/.test(host) || host.includes(':')) throw new WebhookRequestError('Use a host name, not an IP address.');
  if (!host.includes('.') || host.endsWith('.local') || host === 'localhost') throw new WebhookRequestError('Use a public host name.');
  url.hash = '';
  return url.toString();
}

/** Events to send: all when none are chosen. Unknown names are refused, not dropped. */
export function cleanWebhookEvents(raw: unknown): string[] {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return [];
  if (!Array.isArray(raw)) throw new WebhookRequestError('events must be a list.');
  const out = new Set<string>();
  for (const e of raw) {
    if (typeof e !== 'string' || !(WEBHOOK_EVENTS as readonly string[]).includes(e)) throw new WebhookRequestError(`Unknown event: ${String(e).slice(0, 40)}.`);
    out.add(e);
  }
  return WEBHOOK_EVENTS.filter((e) => out.has(e));
}

type EndpointView = { id: string; url: string; label: string; events: string[]; enabled: boolean; secretHint: string | null; createdAt: string };
const ENDPOINT_COLS = 'id, url, label, events, enabled, secret_hint, created_at';
function endpointView(r: Record<string, unknown>): EndpointView {
  return {
    id: String(r.id),
    url: String(r.url),
    label: String(r.label || ''),
    events: Array.isArray(r.events) ? (r.events as string[]) : [],
    enabled: r.enabled === true,
    secretHint: (r.secret_hint as string | null) ?? null,
    createdAt: String(r.created_at || ''),
  };
}

export async function listEndpoints(db: WebhookDb, platformId: string): Promise<EndpointView[]> {
  const { data, error } = await endpoints(db).select(ENDPOINT_COLS).eq('platform_id', platformId).order('created_at', { ascending: true }).limit(MAX_ENDPOINTS * 2);
  if (error) throw new Error(error.message || 'endpoint read failed');
  return ((data as Record<string, unknown>[]) || []).map(endpointView);
}

/** A new endpoint. Its secret is returned once, to show once; only its ciphertext is stored. */
export async function createEndpoint(
  db: WebhookDb,
  platform: Platform,
  input: { url: unknown; label: unknown; events: unknown },
  env: Record<string, string | undefined> = process.env
): Promise<{ endpoint: EndpointView; secret: string }> {
  const url = cleanWebhookUrl(input.url);
  const chosen = cleanWebhookEvents(input.events);
  let key: Buffer;
  try {
    key = webhookKey(env);
  } catch (err) {
    if (err instanceof WebhookKeyMissing) throw new WebhookRequestError('Webhooks are not available yet.');
    throw err;
  }
  if ((await listEndpoints(db, platform.id)).length >= MAX_ENDPOINTS) {
    throw new WebhookRequestError(`A platform can have ${MAX_ENDPOINTS} webhook endpoints. Remove one first.`);
  }
  const id = randomUUID();
  const { secret, hint } = generateWebhookSecret();
  const { data, error } = await endpoints(db)
    .insert({
      id,
      platform_id: platform.id,
      url,
      label: displaySafeLabel(String(input.label ?? ''), 60),
      events: chosen,
      enabled: true,
      secret_ciphertext: encryptWebhookSecret(secret, id, key),
      secret_hint: hint,
    })
    .select(ENDPOINT_COLS)
    .single();
  if (error || !data) throw new Error(error?.message || 'endpoint insert failed');
  // The count above is read before the insert, so two requests at once could
  // both pass it. Counted again now: over the cap, this one takes itself back
  // (and so would a racing one; a retry then fits).
  if ((await listEndpoints(db, platform.id)).length > MAX_ENDPOINTS) {
    await endpoints(db).delete().eq('id', id).eq('platform_id', platform.id);
    throw new WebhookRequestError(`A platform can have ${MAX_ENDPOINTS} webhook endpoints. Remove one first.`);
  }
  return { endpoint: endpointView(data as Record<string, unknown>), secret };
}

/** Remove one of this platform's endpoints; its pending deliveries go with it. False when it is not theirs. */
export async function deleteEndpoint(db: WebhookDb, platform: Platform, id: string): Promise<boolean> {
  const { data, error } = await endpoints(db).delete().eq('id', id).eq('platform_id', platform.id).select('id');
  if (error) throw new Error(error.message || 'endpoint delete failed');
  return Array.isArray(data) && data.length > 0;
}

type DeliveryView = {
  id: string;
  eventType: string;
  endpointId: string;
  status: string;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
};

/** The latest deliveries for this platform, newest first. */
export async function listDeliveries(db: WebhookDb, platformId: string, limit = 20): Promise<DeliveryView[]> {
  const { data, error } = await deliveries(db)
    .select('id, event_id, endpoint_id, status, attempts, last_status, last_error, created_at, delivered_at, next_attempt_at')
    .eq('platform_id', platformId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message || 'delivery read failed');
  const rows = (data as Record<string, unknown>[]) || [];
  const ids = [...new Set(rows.map((r) => String(r.event_id)))];
  const types = new Map<string, string>();
  if (ids.length) {
    const { data: evs, error: evErr } = await events(db).select('id, type').in('id', ids);
    if (evErr) throw new Error(evErr.message || 'event read failed');
    for (const e of (evs as Array<{ id: string; type: string }>) || []) types.set(String(e.id), e.type);
  }
  return rows.map((r) => ({
    id: String(r.id),
    eventType: types.get(String(r.event_id)) || '',
    endpointId: String(r.endpoint_id),
    status: String(r.status),
    attempts: Number(r.attempts || 0),
    lastStatus: (r.last_status as number | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: String(r.created_at || ''),
    deliveredAt: (r.delivered_at as string | null) ?? null,
    nextAttemptAt: r.status === 'pending' ? String(r.next_attempt_at || '') : null,
  }));
}

/** Send a delivery again, now. Only this platform's, and only one not yet delivered. */
export async function retryDelivery(db: WebhookDb, platformId: string, id: string): Promise<boolean> {
  const { data, error } = await deliveries(db)
    .update({ status: 'pending', next_attempt_at: new Date().toISOString() })
    .eq('id', id)
    .eq('platform_id', platformId)
    .in('status', ['failed', 'pending'])
    .select('id');
  if (error) throw new Error(error.message || 'delivery retry failed');
  return Array.isArray(data) && data.length > 0;
}
