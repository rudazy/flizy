import { NextResponse } from 'next/server';
import { apiErrorBody, logApiError } from '../../../../../../lib/apiError';
import { getSupabase } from '../../../../../../lib/supabase';
import { MintError } from '../../../../../../lib/mintExecute.ts';
import { clientErrorResponse, field, readJson } from '../../../../../../lib/mintRequest.ts';
import { drawTraitLayer, imagesReady } from '../../../../../../lib/aiCollection.ts';
import { generationCaller, spendFromWindow } from '../../../../../../lib/generatedRequest.ts';

const ROUTE = 'POST /api/mints/generated/ai/image';

export const maxDuration = 120;

function textField(raw: unknown, what: string, max: number): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > max) throw new MintError(`${what} must be 1 to ${max} characters.`);
  return text;
}

/**
 * Draw one trait layer. Open only inside a paid fee window and counted
 * against its quota before the image service is called.
 */
export async function POST(req: Request) {
  try {
    const caller = await generationCaller(req);
    if ('refuse' in caller) return caller.refuse;
    if (!imagesReady()) return NextResponse.json({ error: 'AI images are not set up yet.' }, { status: 503 });
    const body = await readJson(req);
    const args = {
      style: textField(field(body, 'style'), 'Art style', 40),
      category: textField(field(body, 'category'), 'Category', 40),
      trait: textField(field(body, 'trait'), 'Trait', 40),
      prompt: textField(field(body, 'prompt'), 'Trait description', 400),
      background: field(body, 'background') === true,
    };

    await spendFromWindow(getSupabase(), caller.accountId, 'ai_image', 1);
    try {
      const dataUrl = await drawTraitLayer(args);
      return NextResponse.json({ dataUrl });
    } catch (e) {
      logApiError(ROUTE, e, { accountId: caller.accountId });
      const message = e instanceof Error && /^The image service/.test(e.message) ? e.message : 'The image could not be drawn right now.';
      throw new MintError(message, 502);
    }
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
