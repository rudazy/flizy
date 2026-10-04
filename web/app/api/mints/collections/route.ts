import { NextResponse } from 'next/server';
import { apiErrorBody, logApiError } from '../../../../lib/apiError';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { nftContext, viewerWallet } from '../../../../lib/nftApi.ts';
import { explorerTxUrl } from '../../../../lib/dexServer';
import {
  FACTORY_IFACE,
  NATIVE_MAX_ROYALTY_BPS,
  NATIVE_MAX_SUPPLY,
  mintConfig,
} from '../../../../lib/mintDrop.ts';
import { MAX_DROPS_PER_ACCOUNT, creatorDropCount, insertDrop } from '../../../../lib/mintDrops.ts';
import { MintError, runMintTx } from '../../../../lib/mintExecute.ts';
import {
  artworkUrl,
  chainText,
  clientErrorResponse,
  field,
  intField,
  pageText,
  readJson,
} from '../../../../lib/mintRequest.ts';

const ROUTE = 'POST /api/mints/collections';

/**
 * Create a Flizy-native collection from the creator's wallet through the
 * factory. The creator is its owner and royalty receiver; FlizyDrop is its only
 * minter. The new address is read from the factory's CollectionCreated event
 * in the receipt, matched to this creator, never taken from the request.
 *
 * If the chain step succeeds and saving the drop row fails, the collection
 * still exists and is the creator's: Bring a collection picks it up.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const cfg = mintConfig();
    if (!cfg?.factory) return NextResponse.json({ error: 'Creating collections is not live yet.' }, { status: 503 });
    const body = await readJson(req);

    const name = chainText(field(body, 'name'), 'Name', 64);
    const symbol = chainText(field(body, 'symbol'), 'Symbol', 16);
    const supply = intField(field(body, 'supply'), 'Supply', 1, NATIVE_MAX_SUPPLY);
    const image = artworkUrl(field(body, 'imageUrl'), 'artwork', true) as string;
    const royaltyBps = intField(field(body, 'royaltyBps') ?? 0, 'Royalty', 0, NATIVE_MAX_ROYALTY_BPS);
    const description = pageText(field(body, 'description'), 2000);
    const bannerUrl = artworkUrl(field(body, 'bannerUrl'), 'Banner', false);

    // Before the transaction, so nobody pays gas for a collection Flizy will not list.
    if ((await creatorDropCount(accountId)) >= MAX_DROPS_PER_ACCOUNT) {
      throw new MintError(`An account can have at most ${MAX_DROPS_PER_ACCOUNT} mints on Flizy.`, 429);
    }

    const ctx = nftContext();
    const supabase = getSupabase();
    const viewer = await viewerWallet(accountId);
    const { txHash } = await runMintTx({
      supabase,
      ctx,
      accountId,
      viewer,
      password: String(field(body, 'password') || ''),
      tx: {
        calls: [
          {
            target: cfg.factory,
            value: 0n,
            data: FACTORY_IFACE.encodeFunctionData('create', [name, symbol, BigInt(supply), image, BigInt(royaltyBps)]),
          },
        ],
        value: 0n,
        label: `Create collection ${name}`,
        reason: 'create this collection',
        to: cfg.factory,
      },
    });

    const receipt = await ctx.provider.getTransactionReceipt(txHash);
    let collection: string | null = null;
    for (const log of receipt?.logs ?? []) {
      if (ethers.getAddress(log.address) !== cfg.factory) continue;
      try {
        const parsed = FACTORY_IFACE.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed?.name === 'CollectionCreated' && ethers.getAddress(parsed.args.creator) === viewer.address) {
          collection = ethers.getAddress(parsed.args.collection);
        }
      } catch {
        // not a factory event
      }
    }
    if (!collection) throw new Error(`CollectionCreated not found in ${txHash}`);

    const saved = await insertDrop({
      collection,
      mode: 'flizy',
      creatorAccountId: accountId,
      name,
      description,
      imageUrl: image,
      bannerUrl,
      externalMintFn: null,
    }).catch((saveErr: unknown) => {
      logApiError(ROUTE, saveErr, { accountId, collection: collection ?? '' });
      return null;
    });
    if (!saved) {
      throw new MintError(`Your collection was created at ${collection}, but Flizy could not save it. Bring it to Flizy from Create a Mint.`);
    }
    return NextResponse.json({ ok: true, collection, txHash, explorerUrl: explorerTxUrl(ctx.chain, txHash) });
  } catch (err) {
    return clientErrorResponse(err) ?? NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
