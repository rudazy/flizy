/**
 * Owner-only dashboard background. The table is service-role only. The file
 * lives in a private bucket and is streamed by the session route. The path is
 * a random id, never the account id.
 *
 * Upload slots are claimed in claim_background_upload, eight per account per
 * hour. The row lock makes the count exact under parallel calls. A missing
 * function fails the request.
 */

import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CLIENT_ERROR_MESSAGE, logApiError } from './apiError.ts';
import {
  DEFAULT_APPEARANCE,
  isAppearancePreset,
  type AppearancePreset,
  type PublicAppearance,
} from './appearance.ts';

const ROUTE = 'account background';
export const BACKGROUND_MAX_BYTES = Math.floor(1.5 * 1024 * 1024);
const PATH_RE = /^[a-f0-9]{32}\.(webp|jpg|png)$/;

type StorageFile = Blob | ArrayBuffer | Uint8Array;

type BucketApi = {
  upload: (
    path: string,
    body: Uint8Array,
    options: { contentType: string; upsert: boolean }
  ) => Promise<{ error: { message?: string } | null }>;
  download: (path: string) => Promise<{ data: StorageFile | null; error: { message?: string } | null }>;
  remove: (paths: string[]) => Promise<{ error: { message?: string } | null }>;
};

export type BackgroundDeps = {
  supabase: SupabaseClient;
  now?: number;
  randomId?: () => string;
};

type Row = {
  account_id: string;
  mode: string;
  preset: string | null;
  image_path: string | null;
  dim: number;
  version: number;
};

export type JsonResult = { status: number; body: { error?: string; appearance?: PublicAppearance } };

export type ImageResult =
  | { status: 200; bytes: Uint8Array; contentType: string }
  | { status: 401 | 404; body: { error: string } };

type ImageKind = 'webp' | 'jpeg' | 'png';

export function sniffBackground(bytes: Uint8Array): ImageKind | null {
  if (looksLikeSvg(bytes)) return null;
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  return null;
}

export async function readAppearance(supabase: SupabaseClient, accountId: string): Promise<PublicAppearance> {
  const row = await loadRow(supabase, accountId);
  return toPublic(row);
}

export async function setAppearanceChoice(
  deps: BackgroundDeps,
  accountId: string | null,
  input: { mode?: unknown; preset?: unknown; dim?: unknown }
): Promise<JsonResult> {
  if (!accountId) return { status: 401, body: { error: 'Not logged in' } };
  const mode = input.mode;
  if (mode === 'default') {
    const appearance = await clearChoice(deps, accountId);
    return { status: 200, body: { appearance } };
  }
  if (mode === 'preset') {
    if (!isAppearancePreset(input.preset)) {
      return { status: 400, body: { error: 'Pick a background from the list.' } };
    }
    const row = await loadRow(deps.supabase, accountId);
    const dim = row ? clampDim(row.dim) : DEFAULT_APPEARANCE.dim;
    const version = row && Number.isInteger(row.version) && row.version >= 0 ? row.version : 0;
    const fields: ChoiceFields = {
      mode: 'preset',
      preset: input.preset,
      image_path: null,
      dim,
      version,
    };
    // A row that appears after the read belongs to the newer write.
    if (!row) {
      const inserted = await insertChoice(deps, accountId, fields);
      if (!inserted) {
        return { status: 200, body: { appearance: toPublic(await loadRow(deps.supabase, accountId)) } };
      }
      return { status: 200, body: { appearance: { mode: 'preset', preset: input.preset, dim, version } } };
    }
    const previousPath = row.image_path;
    const stuck = await updateChoice(deps, accountId, previousPath, fields);
    if (!stuck) {
      return { status: 200, body: { appearance: toPublic(await loadRow(deps.supabase, accountId)) } };
    }
    if (previousPath && PATH_RE.test(previousPath)) await removeObject(deps.supabase, previousPath);
    return { status: 200, body: { appearance: { mode: 'preset', preset: input.preset, dim, version } } };
  }
  if (mode === 'image') {
    const dim = parseDim(input.dim);
    if (dim == null) return { status: 400, body: { error: 'Choose a dim from 0 to 90.' } };
    const row = await loadRow(deps.supabase, accountId);
    if (!row || row.mode !== 'image' || !row.image_path) {
      return { status: 400, body: { error: 'Upload an image first.' } };
    }
    const stuck = await updateChoice(deps, accountId, row.image_path, {
      mode: 'image',
      preset: null,
      image_path: row.image_path,
      dim,
      version: row.version,
    });
    if (!stuck) {
      return { status: 200, body: { appearance: toPublic(await loadRow(deps.supabase, accountId)) } };
    }
    return {
      status: 200,
      body: { appearance: { mode: 'image', preset: null, dim, version: row.version } },
    };
  }
  return { status: 400, body: { error: 'Pick a background from the list.' } };
}

export async function uploadBackground(
  deps: BackgroundDeps,
  accountId: string | null,
  bytes: Uint8Array | null,
  dimInput?: unknown
): Promise<JsonResult> {
  if (!accountId) return { status: 401, body: { error: 'Not logged in' } };
  if (!bytes || bytes.length === 0) return { status: 400, body: { error: 'Choose an image.' } };
  if (bytes.length > BACKGROUND_MAX_BYTES) return { status: 400, body: { error: 'That image is too large.' } };
  const kind = sniffBackground(bytes);
  if (!kind) return { status: 400, body: { error: 'Use a WebP, JPEG or PNG image.' } };

  const row = await loadRow(deps.supabase, accountId);
  const previousPath = row?.image_path ?? null;
  const dim = dimInput == null || dimInput === '' ? (row ? clampDim(row.dim) : DEFAULT_APPEARANCE.dim) : parseDim(dimInput);
  if (dim == null) return { status: 400, body: { error: 'Choose a dim from 0 to 90.' } };
  if (!(await claimUpload(deps, accountId))) {
    return { status: 429, body: { error: 'That is too many background uploads. Try again in a few minutes.' } };
  }

  const id = (deps.randomId || newImageId)();
  const ext = kind === 'jpeg' ? 'jpg' : kind;
  const path = `${id}.${ext}`;
  if (!PATH_RE.test(path) || pathNamesAccount(path, accountId)) {
    logApiError(ROUTE, new Error('background path was not a random id'));
    return { status: 500, body: { error: CLIENT_ERROR_MESSAGE } };
  }

  const bucket = bucketOf(deps.supabase);
  const uploaded = await bucket.upload(path, bytes, { contentType: contentTypeOf(kind), upsert: false });
  if (uploaded.error) {
    logApiError(ROUTE, uploaded.error);
    return { status: 500, body: { error: CLIENT_ERROR_MESSAGE } };
  }

  const version = (row?.version ?? 0) + 1;
  try {
    await writeRow(deps, accountId, {
      mode: 'image',
      preset: null,
      image_path: path,
      dim,
      version,
    });
  } catch (err) {
    await removeObject(deps.supabase, path);
    logApiError(ROUTE, err);
    return { status: 500, body: { error: CLIENT_ERROR_MESSAGE } };
  }

  const saved = await loadRow(deps.supabase, accountId);
  if (!saved || saved.image_path !== path) {
    await removeObject(deps.supabase, path);
    return { status: 200, body: { appearance: toPublic(saved) } };
  }
  if (previousPath && previousPath !== path) await removeObject(deps.supabase, previousPath);
  return { status: 200, body: { appearance: toPublic(saved) } };
}

export async function readBackgroundImage(
  deps: BackgroundDeps,
  accountId: string | null
): Promise<ImageResult> {
  if (!accountId) return { status: 401, body: { error: 'Not logged in' } };
  const row = await loadRow(deps.supabase, accountId);
  if (!row || row.mode !== 'image' || !row.image_path || !PATH_RE.test(row.image_path)) {
    return { status: 404, body: { error: 'No background image.' } };
  }
  const downloaded = await bucketOf(deps.supabase).download(row.image_path);
  if (downloaded.error || !downloaded.data) {
    return { status: 404, body: { error: 'No background image.' } };
  }
  const bytes = await toBytes(downloaded.data);
  const kind = sniffBackground(bytes);
  if (!kind) return { status: 404, body: { error: 'No background image.' } };
  return { status: 200, bytes, contentType: contentTypeOf(kind) };
}

/** Account delete. Closure keeps the accounts row, so the foreign key does not fire. */
export async function removeAccountBackground(supabase: SupabaseClient, accountId: string): Promise<void> {
  const row = await loadRow(supabase, accountId);
  if (row?.image_path) await removeObject(supabase, row.image_path);
  const appearance = await supabase.from('account_appearance').delete().eq('account_id', accountId);
  if (appearance.error) throw appearance.error;
  const uploads = await supabase.from('account_background_uploads').delete().eq('account_id', accountId);
  if (uploads.error) throw uploads.error;
}

type ChoiceFields = {
  mode: 'default' | 'preset' | 'image';
  preset: AppearancePreset | null;
  image_path: string | null;
  dim: number;
  version: number;
};

/**
 * Update only if the path we read is still the path on the row.
 * A newer upload keeps its file. The caller deletes the old file only
 * when this write is the one that stuck.
 */
async function updateChoice(
  deps: BackgroundDeps,
  accountId: string,
  expectedPath: string | null,
  fields: ChoiceFields
): Promise<boolean> {
  let query = deps.supabase
    .from('account_appearance')
    .update({
      mode: fields.mode,
      preset: fields.preset,
      image_path: fields.image_path,
      dim: fields.dim,
      version: fields.version,
      updated_at: new Date(deps.now ?? Date.now()).toISOString(),
    })
    .eq('account_id', accountId);
  query = expectedPath ? query.eq('image_path', expectedPath) : query.is('image_path', null);
  const { data, error } = await query.select('account_id');
  if (error) throw error;
  return (Array.isArray(data) ? data : []).length > 0;
}

/** First row for this account. A conflict means another write already inserted one. */
async function insertChoice(deps: BackgroundDeps, accountId: string, fields: ChoiceFields): Promise<boolean> {
  const { error } = await deps.supabase.from('account_appearance').insert({
    account_id: accountId,
    mode: fields.mode,
    preset: fields.preset,
    image_path: fields.image_path,
    dim: fields.dim,
    version: fields.version,
    updated_at: new Date(deps.now ?? Date.now()).toISOString(),
  });
  if (!error) return true;
  if ((error as { code?: string }).code === '23505') return false;
  throw error;
}

/**
 * Back to the build background. The row stays, with its version, so the next
 * upload does not reuse a URL the browser cached for a day.
 */
async function clearChoice(deps: BackgroundDeps, accountId: string): Promise<PublicAppearance> {
  const row = await loadRow(deps.supabase, accountId);
  if (!row) return { ...DEFAULT_APPEARANCE };
  const previousPath = row.image_path;
  const dim = clampDim(row.dim);
  const version = Number.isInteger(row.version) && row.version >= 0 ? row.version : 0;
  const stuck = await updateChoice(deps, accountId, previousPath, {
    mode: 'default',
    preset: null,
    image_path: null,
    dim,
    version,
  });
  if (!stuck) return toPublic(await loadRow(deps.supabase, accountId));
  if (previousPath && PATH_RE.test(previousPath)) await removeObject(deps.supabase, previousPath);
  return { mode: 'default', preset: null, dim, version };
}

/** One slot, or a throw when the database cannot say. Never an open limit. */
async function claimUpload(deps: BackgroundDeps, accountId: string): Promise<boolean> {
  const { data, error } = await deps.supabase.rpc('claim_background_upload', {
    p_account_id: accountId,
  });
  if (error) throw error;
  return data === true;
}

async function loadRow(supabase: SupabaseClient, accountId: string): Promise<Row | null> {
  const { data, error } = await supabase
    .from('account_appearance')
    .select('account_id, mode, preset, image_path, dim, version')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

async function writeRow(
  deps: BackgroundDeps,
  accountId: string,
  fields: {
    mode: 'preset' | 'image';
    preset: AppearancePreset | null;
    image_path: string | null;
    dim: number;
    version: number;
  }
): Promise<void> {
  const { error } = await deps.supabase.from('account_appearance').upsert(
    {
      account_id: accountId,
      mode: fields.mode,
      preset: fields.preset,
      image_path: fields.image_path,
      dim: fields.dim,
      version: fields.version,
      updated_at: new Date(deps.now ?? Date.now()).toISOString(),
    },
    { onConflict: 'account_id' }
  );
  if (error) throw error;
}

function toPublic(row: Row | null): PublicAppearance {
  if (!row) return { ...DEFAULT_APPEARANCE };
  const dim = clampDim(row.dim);
  const version = Number.isInteger(row.version) && row.version >= 0 ? row.version : 0;
  if (row.mode === 'preset' && isAppearancePreset(row.preset)) {
    return { mode: 'preset', preset: row.preset, dim, version };
  }
  if (row.mode === 'image' && row.image_path && PATH_RE.test(row.image_path)) {
    return { mode: 'image', preset: null, dim, version };
  }
  return { mode: 'default', preset: null, dim, version };
}

function bucketOf(supabase: SupabaseClient): BucketApi {
  return supabase.storage.from('user-backgrounds') as unknown as BucketApi;
}

async function removeObject(supabase: SupabaseClient, path: string): Promise<void> {
  if (!PATH_RE.test(path)) return;
  const { error } = await bucketOf(supabase).remove([path]);
  if (error) logApiError(ROUTE, error);
}

function pathNamesAccount(objectPath: string, accountId: string): boolean {
  const lower = objectPath.toLowerCase();
  if (lower.includes(accountId.toLowerCase())) return true;
  const bare = accountId.replace(/-/g, '').toLowerCase();
  return bare.length >= 32 && lower.includes(bare);
}

function newImageId(): string {
  return randomBytes(16).toString('hex');
}

function parseDim(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 90) return value;
  if (typeof value === 'string' && /^\d{1,2}$/.test(value)) {
    const n = Number(value);
    if (n >= 0 && n <= 90) return n;
  }
  return null;
}

function clampDim(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 90) return DEFAULT_APPEARANCE.dim;
  return value;
}

function contentTypeOf(kind: ImageKind): string {
  if (kind === 'webp') return 'image/webp';
  if (kind === 'png') return 'image/png';
  return 'image/jpeg';
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[start + i]);
  return out;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 256);
  let text = '';
  for (let i = 0; i < n; i += 1) text += String.fromCharCode(bytes[i]);
  const head = text.trim().toLowerCase();
  return head.startsWith('<svg') || head.startsWith('<?xml') || head.includes('<svg');
}

async function toBytes(data: StorageFile): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}
