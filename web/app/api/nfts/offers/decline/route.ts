import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { apiErrorBody } from '../../../../../lib/apiError';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { nftContext, viewerWallet } from '../../../../../lib/nftApi.ts';
import { MARKET_ABI } from '../../../../../lib/nftMarket.ts';
import { checkTokenId } from '../../../../../lib/nftIndex.ts';
import { ethFromWei } from '../../../../../lib/nftFormat.ts';
import { notifyAllChannels } from '../../../../../lib/notifyChannels';
import { formatOfferDeclined } from '../../../../../lib/offerNotice.ts';
import { siteOrigin } from '../../../../../lib/siteOrigin';

const ROUTE = 'POST /api/nfts/offers/decline';
const NFT_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)',
];

/**
 * Decline an offer: { offerId }. The contract cannot refuse an offer, so this
 * takes it off the owner's lists (site and chat) and tells the maker in chat,
 * once, that their ETH is still waiting for them to cancel.
 *
 * Only someone who could accept the offer may decline it, read from the chain:
 * the owner of that NFT, or for a collection offer someone holding one from the
 * collection. Otherwise anyone could message anyone who made an offer.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const ctx = nftContext();
    if (!ctx.market) return NextResponse.json({ error: 'Trading is not live yet.' }, { status: 503 });
    const body = await req.json().catch(() => null);
    const offerId = checkTokenId(body?.offerId);
    if (!offerId || offerId === '0') return NextResponse.json({ error: 'Choose an offer.' }, { status: 400 });

    const viewer = await viewerWallet(accountId);
    const market = new ethers.Contract(ctx.market.address, MARKET_ABI, ctx.provider);
    const offer = await market.getOffer(offerId);
    if (offer.maker === ethers.ZeroAddress) return NextResponse.json({ error: 'That offer is no longer open.' }, { status: 409 });
    const maker = ethers.getAddress(offer.maker);
    if (maker === viewer.address) return NextResponse.json({ error: 'That is your own offer. Cancel it instead.' }, { status: 400 });

    const collection = ethers.getAddress(offer.collection);
    const nft = new ethers.Contract(collection, NFT_ABI, ctx.provider);
    const tokenId = offer.anyToken ? null : BigInt(offer.tokenId).toString();
    const canAccept = tokenId
      ? await nft.ownerOf(tokenId).then((o: string) => ethers.getAddress(o) === viewer.address).catch(() => false)
      : await nft.balanceOf(viewer.address).then((b: bigint) => BigInt(b) > 0n).catch(() => false);
    if (!canAccept) return NextResponse.json({ error: 'Only the owner can decline this offer.' }, { status: 403 });

    const supabase = getSupabase();
    const { error } = await supabase
      .from('nft_offer_declines')
      .insert({ account_id: accountId, marketplace: ctx.market.address, offer_id: offerId });
    // Already declined: the maker was told the first time.
    if (error?.code === '23505') return NextResponse.json({ ok: true, declined: true });
    if (error) throw error;

    // The decline is saved; a notice that fails to queue is logged, not reported.
    try {
      const { data: makerAccount } = await supabase
        .from('accounts')
        .select('id')
        .ilike('agent_wallet_address', maker.toLowerCase())
        .maybeSingle();
      if (makerAccount?.id && makerAccount.id !== accountId) {
        const name = await nft.name().catch(() => null);
        const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'NFT';
        await notifyAllChannels(
          makerAccount.id,
          formatOfferDeclined({
            amountEth: ethFromWei(BigInt(offer.amount)) ?? ethers.formatEther(offer.amount),
            nftLabel: tokenId ? `${label} #${tokenId}` : `any ${label}`,
            offersUrl: `${siteOrigin()}/dashboard/explore/nfts/me?tab=made`,
          })
        );
      }
    } catch {
      console.warn(`[${ROUTE}] decline notice was not queued`);
    }

    return NextResponse.json({ ok: true, declined: true });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
