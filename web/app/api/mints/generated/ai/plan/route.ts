import { NextResponse } from 'next/server';
import { apiErrorBody, logApiError } from '../../../../../../lib/apiError';
import { getSupabase } from '../../../../../../lib/supabase';
import { NATIVE_MAX_SUPPLY } from '../../../../../../lib/mintDrop.ts';
import { MintError } from '../../../../../../lib/mintExecute.ts';
import { clientErrorResponse, field, intField, readJson } from '../../../../../../lib/mintRequest.ts';
import { planCollection, planReady } from '../../../../../../lib/aiCollection.ts';
import { planWindow, takeUsage, usageQuota } from '../../../../../../lib/generationFee.ts';
import { generationCaller } from '../../../../../../lib/generatedRequest.ts';

const ROUTE = 'POST /api/mints/generated/ai/plan';

export const maxDuration = 120;

function textField(raw: unknown, what: string, max: number, required: boolean): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (required && !text) throw new MintError(`Add ${what}.`);
  if (text.length > max) throw new MintError(`Keep ${what} under ${max} characters.`);
  return text;
}

/**
 * Plan a collection's categories and traits from the creator's description.
 * Free to try before the fee, so it is capped per account per day instead.
 * The plan comes back checked and is only a starting point the creator edits.
 */
export async function POST(req: Request) {
  try {
    const caller = await generationCaller(req);
    if ('refuse' in caller) return caller.refuse;
    if (!planReady()) return NextResponse.json({ error: 'Generate with AI is not set up yet.' }, { status: 503 });
    const body = await readJson(req);
    const prompt = textField(field(body, 'prompt'), 'a description', 1000, true);
    const size = intField(field(body, 'size'), 'Collection size', 1, NATIVE_MAX_SUPPLY);
    const style = textField(field(body, 'style'), 'the art style', 40, true);
    const custom = textField(field(body, 'custom'), 'the extra instructions', 500, false);
    const includeRaw = field(body, 'include');
    const include = (Array.isArray(includeRaw) ? includeRaw : [])
      .slice(0, 12)
      .map((v) => textField(v, 'a trait name', 30, false))
      .filter(Boolean);

    const supabase = getSupabase();
    const ok = await takeUsage(supabase, caller.accountId, planWindow(), 'ai_plan', 1, usageQuota('ai_plan', 0));
    if (!ok) throw new MintError('You have used today\'s AI plans. Try again tomorrow or edit the last plan.', 429);

    try {
      const plan = await planCollection({ prompt, size, style, include, custom });
      return NextResponse.json({ plan });
    } catch (e) {
      // planCollection's own messages are written for the creator; an SDK error is not.
      if (e instanceof Error && /^The (AI|plan)/.test(e.message)) throw new MintError(e.message, 422);
      logApiError(ROUTE, e, { accountId: caller.accountId });
      throw new MintError('The AI could not plan that right now. Try again shortly.', 502);
    }
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
