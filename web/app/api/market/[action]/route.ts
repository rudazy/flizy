import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody, ClientError, clientMessage } from '../../../../lib/apiError';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { tryAccountTxLock, releaseAccountTxLock } from '../../../../lib/accountTxLock.ts';
import { checkDailyNativeLimit } from '../../../../lib/dailyLimits.ts';
import { explorerTxUrl } from '../../../../lib/dexServer';
import { nftContext, viewerWallet, type NftContext } from '../../../../lib/nftApi.ts';
import { checkAddress, checkTokenId } from '../../../../lib/nftIndex.ts';
import { MARKET_ABI, MAX_ROYALTY_BPS } from '../../../../lib/nftMarket.ts';
import { verifiedCollection } from '../../../../lib/listedNfts';
import { assertCanPay, runMarketCalls, type MarketCall } from '../../../../lib/marketExecute.ts';
import { MARKET_KIND, checkMarketRateLimit } from '../../../../lib/marketRateLimit.ts';
import { notifyAllChannels } from '../../../../lib/notifyChannels';
import { formatOfferReceived } from '../../../../lib/offerNotice.ts';
import { noticeSales } from '../../../../lib/saleNotice.ts';
import { payerLabel } from '../../../../lib/payNotice.ts';
import { siteOrigin } from '../../../../lib/siteOrigin';
import { ethFromWei } from '../../../../lib/nftFormat.ts';

const ACTIONS = ['list', 'cancel', 'buy', 'offer', 'offer-cancel', 'offer-accept', 'royalty', 'withdraw'] as const;
type Action = (typeof ACTIONS)[number];

const NFT_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function owner() view returns (address)',
  'function name() view returns (string)',
];
const NFT_IFACE = new ethers.Interface(NFT_ABI);
const MARKET_IFACE = new ethers.Interface(MARKET_ABI);
const ERC721_ID = '0x80ac58cd';
const MAX_PRICE_WEI = ethers.parseEther('1000000');
const DAY = 24 * 60 * 60;

/** A message written for the person, with the status it should carry. */
class MarketError extends ClientError {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

type Plan = {
  calls: MarketCall[];
  value: bigint;
  label: string;
  /** Finishes "Password is required to ..." */
  reason: string;
  /** An offer on one NFT: its owner hears about it in chat once it is made. */
  offerTo?: { owner: string; collection: string; tokenId: string; nftLabel: string; amountWei: bigint };
};

function field(body: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(body, key) ? body[key] : undefined;
}

function collectionOf(body: Record<string, unknown>): string {
  const address = checkAddress(field(body, 'collection'));
  if (!address) throw new MarketError('Choose a collection.');
  return address;
}

function tokenOf(body: Record<string, unknown>, key = 'tokenId'): string {
  const id = checkTokenId(field(body, key));
  if (!id) throw new MarketError('Choose a token.');
  return id;
}

/** "0.05" style ETH amount typed by a person. */
function ethAmount(raw: unknown, what: string): bigint {
  const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!/^[0-9]{1,7}(\.[0-9]{1,18})?$/.test(text)) throw new MarketError(`Enter a valid ${what} in ETH.`);
  const wei = ethers.parseEther(text);
  if (wei <= 0n || wei > MAX_PRICE_WEI) throw new MarketError(`Enter a valid ${what} in ETH.`);
  return wei;
}

/** A wei amount the page showed and the person reviewed. */
function reviewedWei(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^[0-9]{1,40}$/.test(raw)) throw new MarketError('Review the price again.');
  return BigInt(raw);
}

function expiryFrom(raw: unknown): bigint {
  const days = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 180) throw new MarketError('Choose how long it stays open: 1 to 180 days.');
  return BigInt(Math.floor(Date.now() / 1000) + days * DAY);
}

function label(name: string, tokenId: string | null) {
  return tokenId ? `${name} #${tokenId}` : `any ${name}`;
}

async function collectionName(nft: ethers.Contract, address: string): Promise<string> {
  const name = await nft.name().catch(() => null);
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

async function requireErc721(nft: ethers.Contract) {
  const ok = await nft.supportsInterface(ERC721_ID).catch(() => false);
  if (!ok) throw new MarketError('Only ERC-721 NFTs can be traded here.');
}

/**
 * Approves the marketplace for this one token when it is not already. Never
 * setApprovalForAll: the marketplace only ever needs the token being sold, and
 * a per-token approval is cleared by every transfer, which is what ends a
 * listing when the NFT leaves the wallet (FlizyMarketplace.sol).
 */
async function approvalCalls(nft: ethers.Contract, collection: string, tokenId: string, market: string): Promise<MarketCall[]> {
  const current = await nft.getApproved(tokenId).catch(() => null);
  if (typeof current === 'string' && ethers.getAddress(current) === market) return [];
  return [{ target: collection, value: 0n, data: NFT_IFACE.encodeFunctionData('approve', [market, tokenId]) }];
}

/** The royalty rate the seller saw on the review screen, in basis points. */
function reviewedRoyaltyBps(raw: unknown): number {
  const bps = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_ROYALTY_BPS) throw new MarketError('Review the royalty again.');
  return bps;
}

function unverifiedReason(collection: string, verb: string) {
  return verifiedCollection(collection) ? `${verb} this NFT` : `${verb} an NFT Flizy has not verified`;
}

async function buildPlan(
  action: Action,
  body: Record<string, unknown>,
  ctx: NftContext,
  marketAddress: string,
  viewer: string
): Promise<Plan> {
  const market = new ethers.Contract(marketAddress, MARKET_ABI, ctx.provider);
  const call = (fn: string, args: unknown[], value = 0n): MarketCall => ({
    target: marketAddress,
    value,
    data: MARKET_IFACE.encodeFunctionData(fn, args),
  });

  if (action === 'withdraw') {
    const credit = BigInt(await market.credits(viewer));
    if (credit === 0n) throw new MarketError('Nothing to withdraw.');
    return { calls: [call('withdraw', [])], value: 0n, label: `Withdraw ${ethers.formatEther(credit)} ETH from sales`, reason: 'withdraw' };
  }

  if (action === 'offer-cancel') {
    const offerId = checkTokenId(field(body, 'offerId'));
    if (!offerId) throw new MarketError('Choose an offer.');
    const offer = await market.getOffer(offerId);
    if (ethers.getAddress(offer.maker) !== viewer) throw new MarketError('That is not your offer.', 403);
    return {
      calls: [call('cancelOffer', [offerId])],
      value: 0n,
      label: `Cancel offer of ${ethers.formatEther(offer.amount)} ETH`,
      reason: 'cancel this offer',
    };
  }

  if (action === 'offer-accept') {
    const offerId = checkTokenId(field(body, 'offerId'));
    if (!offerId) throw new MarketError('Choose an offer.');
    const tokenId = tokenOf(body);
    const reviewed = reviewedWei(field(body, 'amountWei'));
    const maxRoyaltyBps = reviewedRoyaltyBps(field(body, 'maxRoyaltyBps'));
    const offer = await market.getOffer(offerId);
    if (offer.maker === ethers.ZeroAddress) throw new MarketError('That offer is no longer open.', 409);
    if (BigInt(offer.amount) !== reviewed) throw new MarketError('The offer changed. Review it again.', 409);
    if (Number(offer.expiry) < Math.floor(Date.now() / 1000)) throw new MarketError('That offer has expired.', 409);
    if (!offer.anyToken && BigInt(offer.tokenId).toString() !== tokenId) throw new MarketError('That offer is for another token.');
    const collection = ethers.getAddress(offer.collection);
    const nft = new ethers.Contract(collection, NFT_ABI, ctx.provider);
    const owner = await nft.ownerOf(tokenId).catch(() => null);
    if (!owner || ethers.getAddress(owner) !== viewer) throw new MarketError('You do not own this NFT.', 403);
    const name = await collectionName(nft, collection);
    return {
      calls: [
        ...(await approvalCalls(nft, collection, tokenId, marketAddress)),
        call('acceptOffer', [offerId, tokenId, reviewed, maxRoyaltyBps]),
      ],
      value: 0n,
      label: `Sell ${label(name, tokenId)} for ${ethers.formatEther(reviewed)} ETH`,
      reason: unverifiedReason(collection, 'sell'),
    };
  }

  const collection = collectionOf(body);
  const nft = new ethers.Contract(collection, NFT_ABI, ctx.provider);
  const name = await collectionName(nft, collection);

  if (action === 'royalty') {
    const bps = Number(field(body, 'bps'));
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_ROYALTY_BPS) throw new MarketError('Royalty must be between 0% and 10%.');
    const owner = await nft.owner().catch(() => null);
    if (!owner || ethers.getAddress(owner) !== viewer) {
      throw new MarketError("Only the collection contract's owner can set its royalty.", 403);
    }
    const receiver = checkAddress(field(body, 'receiver')) || viewer;
    return {
      calls: [call('setRoyalty', [collection, bps === 0 ? ethers.ZeroAddress : receiver, bps])],
      value: 0n,
      label: `Set ${name} royalty to ${bps / 100}%`,
      reason: 'set the royalty',
    };
  }

  if (action === 'offer') {
    await requireErc721(nft);
    const rawToken = field(body, 'tokenId');
    const tokenId = rawToken == null || rawToken === '' ? null : tokenOf(body);
    let tokenOwner: string | null = null;
    if (tokenId) {
      const owner = await nft.ownerOf(tokenId).catch(() => null);
      if (!owner) throw new MarketError('This token does not exist.');
      tokenOwner = ethers.getAddress(owner);
      if (tokenOwner === viewer) throw new MarketError('You already own this NFT.');
    }
    const amount = ethAmount(field(body, 'amountEth'), 'offer');
    const expiry = expiryFrom(field(body, 'days'));
    return {
      calls: [call('makeOffer', [collection, tokenId ?? 0, tokenId == null, expiry], amount)],
      value: amount,
      label: `Offer ${ethers.formatEther(amount)} ETH for ${label(name, tokenId)}`,
      reason: unverifiedReason(collection, 'make an offer on'),
      // A collection offer names no one token, so it has no single owner to tell.
      offerTo: tokenId && tokenOwner
        ? { owner: tokenOwner, collection, tokenId, nftLabel: label(name, tokenId), amountWei: amount }
        : undefined,
    };
  }

  const tokenId = tokenOf(body);

  if (action === 'list') {
    await requireErc721(nft);
    const owner = await nft.ownerOf(tokenId).catch(() => null);
    if (!owner || ethers.getAddress(owner) !== viewer) throw new MarketError('You do not own this NFT.', 403);
    const price = ethAmount(field(body, 'priceEth'), 'price');
    const expiry = expiryFrom(field(body, 'days'));
    return {
      calls: [...(await approvalCalls(nft, collection, tokenId, marketAddress)), call('list', [collection, tokenId, price, expiry])],
      value: 0n,
      label: `List ${label(name, tokenId)} for ${ethers.formatEther(price)} ETH`,
      reason: unverifiedReason(collection, 'list'),
    };
  }

  const listing = await market.getListing(collection, tokenId);
  const seller = ethers.getAddress(listing.seller);

  if (action === 'cancel') {
    if (seller === ethers.ZeroAddress) throw new MarketError('This NFT is not listed.', 409);
    const owner = await nft.ownerOf(tokenId).catch(() => null);
    if (seller !== viewer && (!owner || ethers.getAddress(owner) !== viewer)) {
      throw new MarketError('Only the seller can cancel this listing.', 403);
    }
    return { calls: [call('cancelListing', [collection, tokenId])], value: 0n, label: `Cancel listing of ${label(name, tokenId)}`, reason: 'cancel this listing' };
  }

  // buy
  const reviewed = reviewedWei(field(body, 'priceWei'));
  if (seller === ethers.ZeroAddress) throw new MarketError('This NFT is no longer for sale.', 409);
  if (BigInt(listing.price) !== reviewed) throw new MarketError('The price changed. Review it again.', 409);
  if (seller === viewer) throw new MarketError('This is your own listing.');
  const valid = await market.isListingValid(collection, tokenId).catch(() => false);
  if (!valid) throw new MarketError('This NFT is no longer for sale.', 409);
  return {
    calls: [call('buy', [collection, tokenId, reviewed], reviewed)],
    value: reviewed,
    label: `Buy ${label(name, tokenId)} for ${ethers.formatEther(reviewed)} ETH`,
    reason: unverifiedReason(collection, 'buy'),
  };
}

/**
 * Tells an NFT's owner in chat that an offer was made on it, if the owner is a
 * Flizy account. The owner is found by the wallet that holds the NFT, the same
 * lookup chat uses for a received payment (lib/router.js). The offer is already
 * on chain: a notice that fails to queue is logged, never reported as a failed
 * offer.
 */
async function noticeOffer(
  supabase: ReturnType<typeof getSupabase>,
  offererId: string,
  offer: NonNullable<Plan['offerTo']>
) {
  try {
    const { data: owner } = await supabase
      .from('accounts')
      .select('id')
      .ilike('agent_wallet_address', offer.owner.toLowerCase())
      .maybeSingle();
    if (!owner?.id || owner.id === offererId) return;
    const { data: offerer } = await supabase
      .from('accounts')
      .select('username, display_name')
      .eq('id', offererId)
      .maybeSingle();
    await notifyAllChannels(
      owner.id,
      formatOfferReceived({
        amountEth: ethFromWei(offer.amountWei) ?? ethers.formatEther(offer.amountWei),
        nftLabel: offer.nftLabel,
        fromLabel: payerLabel(offerer),
        itemUrl: `${siteOrigin()}/dashboard/explore/nfts/${offer.collection}/${offer.tokenId}`,
      })
    );
  } catch {
    console.warn('[market] offer notice was not queued');
  }
}

/**
 * Every marketplace action from the site. Each one is read and checked against
 * the chain first, then takes the account password, the daily ETH limit (for
 * buys and offers, which send ETH to someone else), the account lock, and is
 * logged in transfers before it is sent.
 */
export async function POST(req: Request, { params }: { params: { action: string } }) {
  const route = `POST /api/market/${ACTIONS.includes(params.action as Action) ? params.action : '[action]'}`;
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    if (!ACTIONS.includes(params.action as Action)) return NextResponse.json({ error: 'Unknown action' }, { status: 404 });
    const action = params.action as Action;

    const ctx = nftContext();
    if (!ctx.market) return NextResponse.json({ error: 'Trading is not live yet.' }, { status: 503 });
    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const body = raw as Record<string, unknown>;

    const supabase = getSupabase();
    const rate = await checkMarketRateLimit(supabase, accountId);
    if (!rate.ok) return NextResponse.json({ error: rate.error, code: rate.code }, { status: rate.status });

    const viewer = await viewerWallet(accountId);
    const marketContract = new ethers.Contract(ctx.market.address, MARKET_ABI, ctx.provider);
    const paused = await marketContract.paused().catch(() => false);
    const exits = action === 'cancel' || action === 'offer-cancel' || action === 'withdraw';
    if (paused && !exits) return NextResponse.json({ error: 'Trading is paused right now.' }, { status: 503 });

    const plan = await buildPlan(action, body, ctx, ctx.market.address, viewer.address);

    const auth = await requirePassword(supabase, accountId, String(field(body, 'password') || ''), plan.reason);
    if (!auth.ok) return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });

    const lock = await tryAccountTxLock(supabase, accountId, MARKET_KIND);
    if (!lock.ok) return NextResponse.json({ error: lock.error }, { status: 409 });
    try {
      // Under the lock, as in pay/execute: a check taken before it would let two
      // requests both read today's total before either one's row exists.
      if (plan.value > 0n) {
        const daily = await checkDailyNativeLimit(supabase, accountId, plan.value);
        if (!daily.ok) return NextResponse.json({ error: daily.message }, { status: 403 });
      }
      await assertCanPay(ctx.provider, viewer, plan.value, plan.calls.length);

      const { data: logRow, error: logError } = await supabase
        .from('transfers')
        .insert({
          account_id: accountId,
          phone: 'site',
          to_address: ctx.market.address,
          amount_eth: ethers.formatEther(plan.value),
          status: 'pending',
          chain_id: ctx.chain.chainId,
          kind: MARKET_KIND,
          asset: 'ETH',
          counterparty_label: plan.label,
          direction: 'out',
        })
        .select('id')
        .maybeSingle();
      // The database's reason goes to the server log through apiErrorBody; the
      // person only ever sees the generic message.
      if (!logRow?.id) throw new Error(`could not log marketplace action: ${logError?.message || 'no row returned'}`);

      try {
        const txHash = await runMarketCalls({
          accountId,
          provider: ctx.provider,
          chainId: ctx.chain.chainId,
          viaGator: viewer.viaGator,
          calls: plan.calls,
        });
        await supabase.from('transfers').update({ status: 'confirmed', tx_hash: txHash }).eq('id', logRow.id);
        if (plan.offerTo) await noticeOffer(supabase, accountId, plan.offerTo);
        // A sale tells the other side: the seller when someone buys, the buyer
        // when their offer is accepted. Figures come from the Sold event.
        if (action === 'buy' || action === 'offer-accept') {
          await noticeSales({
            provider: ctx.provider,
            txHash,
            marketAddress: ctx.market.address,
            actorAccountId: accountId,
            siteUrl: siteOrigin(),
          });
        }
        return NextResponse.json({ ok: true, txHash, explorerUrl: explorerTxUrl(ctx.chain, txHash), label: plan.label });
      } catch (sendErr) {
        await supabase
          .from('transfers')
          .update({ status: 'failed', error: sendErr instanceof Error ? sendErr.message.slice(0, 500) : 'failed' })
          .eq('id', logRow.id);
        throw sendErr;
      }
    } finally {
      await releaseAccountTxLock(supabase, accountId);
    }
  } catch (err) {
    if (err instanceof ClientError) {
      return NextResponse.json({ error: clientMessage(err) }, { status: err instanceof MarketError ? err.status : 400 });
    }
    return NextResponse.json(apiErrorBody(route, err), { status: 500 });
  }
}
