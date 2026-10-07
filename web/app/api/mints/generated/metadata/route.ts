import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../../lib/apiError';
import { getSupabase } from '../../../../../lib/supabase';
import { MintError } from '../../../../../lib/mintExecute.ts';
import { chainText, clientErrorResponse, field, pageText, readJson } from '../../../../../lib/mintRequest.ts';
import { metadataFiles, pinFolder, storageReady } from '../../../../../lib/collectionStorage.ts';
import { openFeeWindow } from '../../../../../lib/generationFee.ts';
import { generationCaller, spendFromWindow } from '../../../../../lib/generatedRequest.ts';

const ROUTE = 'POST /api/mints/generated/metadata';

export const maxDuration = 60;

/**
 * Write and store the collection's metadata folder: one standard ERC-721 JSON
 * file per NFT, built here from the checked name, description, stored image
 * and traits. Returns the base URI the collection contract is created with.
 */
export async function POST(req: Request) {
  try {
    const caller = await generationCaller(req);
    if ('refuse' in caller) return caller.refuse;
    if (!storageReady()) return NextResponse.json({ error: 'Storage is not set up yet.' }, { status: 503 });
    const body = await readJson(req);
    const name = chainText(field(body, 'name'), 'Name', 64);
    const description = pageText(field(body, 'description'), 2000) ?? '';

    const supabase = getSupabase();
    const window = await openFeeWindow(supabase, caller.accountId);
    if (!window) throw new MintError('Pay the generation fee first.', 402);
    let files: Array<{ path: string; text: string }>;
    try {
      files = metadataFiles(name, description, field(body, 'tokens'), window.supply);
    } catch (e) {
      throw new MintError(e instanceof Error ? e.message : 'The NFTs could not be read.');
    }

    await spendFromWindow(supabase, caller.accountId, 'pin_metadata', 1);
    const folder = `flizy-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const baseURI = await pinFolder(folder, files);
    return NextResponse.json({ baseURI, count: files.length });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
