import { NextResponse } from 'next/server';
import { apiErrorBody } from '../../../../../lib/apiError';
import { getSupabase } from '../../../../../lib/supabase';
import { nftContext } from '../../../../../lib/nftApi.ts';
import { mintConfig } from '../../../../../lib/mintDrop.ts';
import { storageReady } from '../../../../../lib/collectionStorage.ts';
import { imagesReady, planReady } from '../../../../../lib/aiCollection.ts';
import { GENERATION_FEE_USD, openFeeWindow } from '../../../../../lib/generationFee.ts';
import { factorySupportsMetadata, feeQuote, generationCaller } from '../../../../../lib/generatedRequest.ts';

const ROUTE = 'GET /api/mints/generated/status';

/**
 * What the creator's Launch and AI screens need to know before offering
 * anything: the fee in test ETH, whether it is already paid, and which of
 * storage, the metadata factory and the AI services are set up. Each one off
 * is shown as off; nothing here is guessed.
 */
export async function GET(req: Request) {
  try {
    const caller = await generationCaller(req);
    if ('refuse' in caller) return caller.refuse;
    const ctx = nftContext();
    const cfg = mintConfig();
    const [quote, window, metadataFactory] = await Promise.all([
      feeQuote(),
      openFeeWindow(getSupabase(), caller.accountId),
      cfg?.factory ? factorySupportsMetadata(ctx.provider, cfg.factory).catch(() => false) : Promise.resolve(false),
    ]);
    return NextResponse.json({
      network: ctx.chain.name,
      feeUsd: GENERATION_FEE_USD,
      feeWei: quote ? quote.feeWei.toString() : null,
      usdPerEth: quote?.usdPerEth ?? null,
      window,
      storage: storageReady(),
      metadataFactory,
      aiPlan: planReady(),
      aiImages: imagesReady(),
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
