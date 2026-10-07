import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { apiErrorBody } from '../../../../../lib/apiError';
import { getSupabase } from '../../../../../lib/supabase';
import { nftContext, viewerWallet } from '../../../../../lib/nftApi.ts';
import { explorerTxUrl } from '../../../../../lib/dexServer';
import { NATIVE_MAX_SUPPLY, mintConfig } from '../../../../../lib/mintDrop.ts';
import { MintError, runMintTx } from '../../../../../lib/mintExecute.ts';
import { chainText, clientErrorResponse, field, intField, readJson } from '../../../../../lib/mintRequest.ts';
import { feeLabel, openFeeWindow } from '../../../../../lib/generationFee.ts';
import { feeQuote, feeRecipient, generationCaller } from '../../../../../lib/generatedRequest.ts';

const ROUTE = 'POST /api/mints/generated/pay';

/**
 * Pay the $2 generation fee in test ETH, from the creator's wallet to Flizy's
 * fee wallet, through the same gated path as every mint action (password,
 * lock, daily limit, balance). The amount is worked out here at the current
 * rate; the screen sends the amount it showed, and if the rate has since moved
 * the fee up, nothing is sent and the new figure is shown instead.
 */
export async function POST(req: Request) {
  try {
    const caller = await generationCaller(req);
    if ('refuse' in caller) return caller.refuse;
    const { accountId } = caller;
    const cfg = mintConfig();
    if (!cfg) return NextResponse.json({ error: 'Creating collections is not live yet.' }, { status: 503 });
    const body = await readJson(req);
    const name = chainText(field(body, 'name'), 'Name', 64);
    const supply = intField(field(body, 'supply'), 'Supply', 1, NATIVE_MAX_SUPPLY);
    const quotedRaw = String(field(body, 'quotedWei') ?? '');
    if (!/^[0-9]{1,30}$/.test(quotedRaw)) throw new MintError('Refresh to see the fee.');

    const supabase = getSupabase();
    const refuseIfPaid = async () => {
      const open = await openFeeWindow(supabase, accountId);
      if (open && open.supply >= supply) {
        throw new MintError('The fee is already paid for this collection. Carry on.', 409, 'FEE_ALREADY_PAID');
      }
    };
    await refuseIfPaid();

    const quote = await feeQuote();
    if (!quote) throw new MintError('The ETH price is not available right now, so no fee can be worked out. Try again shortly.', 503);
    if (quote.feeWei > BigInt(quotedRaw)) {
      throw new MintError(
        `The ETH price moved. The fee is now ${ethers.formatEther(quote.feeWei)} ETH. Check it and pay again.`,
        409,
        'FEE_CHANGED'
      );
    }

    const ctx = nftContext();
    const to = await feeRecipient(ctx.provider, cfg.drop);
    const viewer = await viewerWallet(accountId);
    const { txHash } = await runMintTx({
      supabase,
      ctx,
      accountId,
      viewer,
      password: String(field(body, 'password') || ''),
      // Again under the lock, so two quick payments cannot both go through.
      underLock: refuseIfPaid,
      tx: {
        calls: [{ target: to, value: quote.feeWei, data: '0x' }],
        value: quote.feeWei,
        label: feeLabel(name, supply),
        reason: 'pay the generation fee',
        to,
      },
    });
    const window = await openFeeWindow(supabase, accountId);
    return NextResponse.json({
      ok: true,
      txHash,
      explorerUrl: explorerTxUrl(ctx.chain, txHash),
      feeWei: quote.feeWei.toString(),
      window,
    });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
