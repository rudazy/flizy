import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../../lib/apiError';
import { getSupabase } from '../../../../../lib/supabase';
import { MintError } from '../../../../../lib/mintExecute.ts';
import { clientErrorResponse, field, readJson } from '../../../../../lib/mintRequest.ts';
import { decodeImageDataUrl, pinFile, storageReady } from '../../../../../lib/collectionStorage.ts';
import { generationCaller, spendFromWindow } from '../../../../../lib/generatedRequest.ts';

const ROUTE = 'POST /api/mints/generated/images';

export const maxDuration = 60;

/** Per request, so a batch stays under the platform's body limit. */
const MAX_PER_REQUEST = 8;
const MAX_REQUEST_BYTES = 3_000_000;

/**
 * Store a batch of finished NFT images (or the cover) on IPFS. Open only
 * inside a paid fee window, and counted against its quota before anything is
 * uploaded. Each file must really be the PNG, JPEG or WebP it says it is.
 */
export async function POST(req: Request) {
  try {
    const caller = await generationCaller(req);
    if ('refuse' in caller) return caller.refuse;
    if (!storageReady()) return NextResponse.json({ error: 'Storage is not set up yet.' }, { status: 503 });
    const body = await readJson(req);
    const list = field(body, 'images');
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PER_REQUEST) {
      throw new MintError(`Send 1 to ${MAX_PER_REQUEST} images at a time.`);
    }
    const images = list.map((raw, i) => {
      const img = decodeImageDataUrl(raw);
      if (!img) throw new MintError(`Image ${i + 1} is not a PNG, JPEG or WebP under 1 MB.`);
      return img;
    });
    if (images.reduce((n, img) => n + img.bytes.length, 0) > MAX_REQUEST_BYTES) {
      throw new MintError('Send fewer images at a time.');
    }

    await spendFromWindow(getSupabase(), caller.accountId, 'pin_image', images.length);
    const uris = await Promise.all(images.map((img, i) => pinFile(`image-${i + 1}.${img.ext}`, img.bytes, img.mime)));
    return NextResponse.json({ uris });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
