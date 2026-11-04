import { createHash } from 'crypto';

/**
 * Idempotency-Key handling for Flizy Pay API writes.
 *
 * Every POST carries an Idempotency-Key. The first request with a key is
 * recorded before any work starts; a repeat with the same key and the same
 * request gets the first answer back unchanged, so a platform can retry after a
 * timeout without paying twice. The same key with a different request is
 * refused, and a repeat that arrives while the first is still running is told
 * to wait. The database's primary key (key_id, idempotency_key) makes the first
 * insert win when two arrive together. Records are kept 24 hours.
 *
 * Imports only crypto, so node --test loads this file directly.
 */

export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

type DbError = { code?: string; message?: string } | null;
type Query = PromiseLike<{ data: unknown; error: DbError }> & {
  select(cols: string): Query;
  insert(values: Record<string, unknown>): Query;
  update(values: Record<string, unknown>): Query;
  delete(): Query;
  eq(col: string, value: unknown): Query;
  maybeSingle(): PromiseLike<{ data: unknown; error: DbError }>;
};
export type IdemDb = { from: (table: string) => unknown };
function table(db: IdemDb): Query {
  return db.from('api_idempotency') as Query;
}

/** A digest of what was asked: method, path and the exact body. */
export function requestHash(method: string, path: string, body: string): string {
  return createHash('sha256').update(`${method.toUpperCase()}\n${path}\n${body}`, 'utf8').digest('hex');
}

export type IdemStart =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

type Row = { request_hash: string; state: string; response_status: number | null; response_body: unknown; expires_at: string };

export async function beginIdempotent(
  db: IdemDb,
  keyId: string,
  idempotencyKey: string | null,
  hash: string,
  now = Date.now()
): Promise<IdemStart> {
  if (!idempotencyKey || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) return { kind: 'invalid' };
  const read = async (): Promise<Row | null | 'error'> => {
    const { data, error } = await table(db)
      .select('request_hash, state, response_status, response_body, expires_at')
      .eq('key_id', keyId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    return error ? 'error' : (data as Row | null);
  };

  const existing = await read();
  if (existing === 'error') return { kind: 'unavailable' };
  if (existing && Date.parse(existing.expires_at) > now) {
    if (existing.request_hash !== hash) return { kind: 'conflict' };
    if (existing.state === 'done' && existing.response_status != null) {
      return { kind: 'replay', status: existing.response_status, body: existing.response_body };
    }
    return { kind: 'in_progress' };
  }
  if (existing) {
    // Past its 24 hours: the key may be used again for a new request.
    const { error: delErr } = await table(db).delete().eq('key_id', keyId).eq('idempotency_key', idempotencyKey);
    if (delErr) return { kind: 'unavailable' };
  }

  const { error } = await table(db).insert({ key_id: keyId, idempotency_key: idempotencyKey, request_hash: hash });
  if (!error) return { kind: 'new' };
  // Another request with this key got in first: answer as a repeat of it.
  if (error.code === '23505') {
    const winner = await read();
    if (winner === 'error' || !winner) return { kind: 'unavailable' };
    return winner.request_hash === hash ? { kind: 'in_progress' } : { kind: 'conflict' };
  }
  return { kind: 'unavailable' };
}

/** Store the answer so a repeat gets exactly this back. */
export async function finishIdempotent(
  db: IdemDb,
  keyId: string,
  idempotencyKey: string,
  status: number,
  body: unknown
): Promise<void> {
  await table(db)
    .update({ state: 'done', response_status: status, response_body: body })
    .eq('key_id', keyId)
    .eq('idempotency_key', idempotencyKey);
}
