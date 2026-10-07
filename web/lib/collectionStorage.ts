/**
 * IPFS storage for generated collections, through Pinata. Off until
 * PINATA_JWT is set; every caller checks storageReady first and says so.
 *
 * Images are pinned one file at a time and come back as ipfs://<cid>. The
 * metadata is pinned as one folder, so a collection's tokenURI is
 * ipfs://<folder cid>/<id>.json for every token.
 */

const PIN_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;

export type PinFetch = (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

const defaultFetch: PinFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });

export function storageReady(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.PINATA_JWT && env.PINATA_JWT.trim().length > 20);
}

async function pin(form: FormData, env: Record<string, string | undefined>, fetcher: PinFetch): Promise<string> {
  const jwt = env.PINATA_JWT?.trim();
  if (!jwt) throw new Error('storage not configured');
  const res = await fetcher(PIN_URL, { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
  if (!res.ok) throw new Error(`storage refused the upload (${res.status})`);
  const body = (await res.json().catch(() => null)) as { IpfsHash?: unknown } | null;
  const cid = typeof body?.IpfsHash === 'string' ? body.IpfsHash : '';
  if (!CID.test(cid)) throw new Error('storage returned no content id');
  return cid;
}

/** One file, as ipfs://<cid>. */
export async function pinFile(
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  env: Record<string, string | undefined> = process.env,
  fetcher: PinFetch = defaultFetch
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), name);
  form.append('pinataMetadata', JSON.stringify({ name }));
  return `ipfs://${await pin(form, env, fetcher)}`;
}

export const MAX_IMAGE_BYTES = 1_000_000;

const IMAGE_TYPES: Array<{ mime: string; ext: string; magic: (b: Uint8Array) => boolean }> = [
  { mime: 'image/png', ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/webp',
    ext: 'webp',
    magic: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

/**
 * A PNG, JPEG or WebP data URL to bytes, or null. The declared type must match
 * the file's own signature, so nothing else is stored under an image name.
 */
export function decodeImageDataUrl(raw: unknown): { bytes: Uint8Array<ArrayBuffer>; mime: string; ext: string } | null {
  if (typeof raw !== 'string' || raw.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!m) return null;
  const type = IMAGE_TYPES.find((t) => t.mime === m[1]);
  const bytes = new Uint8Array(Buffer.from(m[2], 'base64'));
  if (!type || bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES || !type.magic(bytes)) return null;
  return { bytes, mime: type.mime, ext: type.ext };
}

const STORED_IMAGE = /^ipfs:\/\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;
const ATTR_TEXT = /^[\x20-\x7e]{1,64}$/;

export type MetadataToken = { image: string; attributes: Array<{ trait_type: string; value: string }> };

/**
 * The metadata folder for a collection: <id>.json for ids 1..n, written here
 * from checked parts so nothing the browser sends lands in a file unread.
 * Images must be ones this storage returned (ipfs://<cid>).
 */
export function metadataFiles(
  name: string,
  description: string,
  tokens: unknown,
  maxTokens: number
): Array<{ path: string; text: string }> {
  if (!Array.isArray(tokens) || tokens.length < 1) throw new Error('Add the NFTs first.');
  if (tokens.length > maxTokens) throw new Error(`The fee you paid covers ${maxTokens} NFTs.`);
  return tokens.map((raw, i) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    const image = typeof t.image === 'string' ? t.image : '';
    if (!STORED_IMAGE.test(image)) throw new Error(`NFT ${i + 1} has no stored image.`);
    const attrs = Array.isArray(t.attributes) ? t.attributes : [];
    if (attrs.length > 20) throw new Error(`NFT ${i + 1} has too many traits.`);
    const attributes = attrs.map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      const trait_type = typeof o.trait_type === 'string' ? o.trait_type.trim() : '';
      const value = typeof o.value === 'string' ? o.value.trim() : '';
      if (!ATTR_TEXT.test(trait_type) || !ATTR_TEXT.test(value)) throw new Error(`NFT ${i + 1} has a trait with an unusable name.`);
      return { trait_type, value };
    });
    const id = i + 1;
    const doc = { name: `${name} #${id}`, description, image, attributes };
    return { path: `${id}.json`, text: JSON.stringify(doc) };
  });
}

/** Files under one folder, as ipfs://<folder cid>/ (with the trailing slash a base URI needs). */
export async function pinFolder(
  folder: string,
  files: Array<{ path: string; text: string }>,
  env: Record<string, string | undefined> = process.env,
  fetcher: PinFetch = defaultFetch
): Promise<string> {
  if (!/^[a-z0-9-]{1,40}$/.test(folder)) throw new Error('bad folder name');
  const form = new FormData();
  for (const f of files) {
    if (!/^[a-z0-9-]{1,40}\.json$/.test(f.path)) throw new Error('bad file name');
    form.append('file', new Blob([f.text], { type: 'application/json' }), `${folder}/${f.path}`);
  }
  form.append('pinataMetadata', JSON.stringify({ name: folder }));
  return `ipfs://${await pin(form, env, fetcher)}/`;
}
