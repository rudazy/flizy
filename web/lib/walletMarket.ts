import { ethers } from 'ethers';
import { getSupabase } from './supabase';
import { notifyAllChannels } from './notifyChannels';
import { MARKET_ABI } from './nftMarket.ts';
import { noticeSales } from './saleNotice';
import { formatOfferReceived } from './offerNotice.ts';
import { ethFromWei } from './nftFormat.ts';

/**
 * Notices for marketplace trades, announced once per transaction.
 *
 * A Flizy account hears in chat when its NFT gets an offer or is sold. Trades
 * from a Flizy wallet announce from the market route; trades a visitor signs
 * in wallet mode announce when the page hands over the hash, and the server
 * reads what happened from the marketplace's own events in that transaction's
 * receipt. Both claim the hash in market_tx_notices first
 * (supabase/migrations/20261022120000_market_tx_notices.sql), so nothing is
 * announced twice.
 */

export type Db = ReturnType<typeof getSupabase>;

const MARKET_IFACE = new ethers.Interface(MARKET_ABI);

/** How old a wallet-mode trade may be and still be announced. The page hands the hash over as soon as it lands. */
export const NOTICE_WINDOW_S = 60 * 60;
const NFT_ABI = ['function ownerOf(uint256) view returns (address)', 'function name() view returns (string)'];

/** Claim a transaction for its notices. True only for the first claim. */
export async function claimNotice(supabase: Db, txHash: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('market_tx_notices')
    .upsert({ tx_hash: txHash.toLowerCase() }, { onConflict: 'tx_hash', ignoreDuplicates: true })
    .select('tx_hash');
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data.length > 0 : Boolean(data);
}

type OfferMade = { offerId: string; collection: string; maker: string; tokenId: string | null; amount: bigint };

/** Offers made in a receipt, from the marketplace's own log only. */
function offersInReceipt(
  receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> } | null,
  marketAddress: string
): OfferMade[] {
  const market = ethers.getAddress(marketAddress);
  const out: OfferMade[] = [];
  for (const log of receipt?.logs ?? []) {
    if (!log.address || ethers.getAddress(log.address) !== market) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = MARKET_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.name !== 'OfferMade') continue;
    const a = parsed.args;
    out.push({
      offerId: a.offerId.toString(),
      collection: ethers.getAddress(a.collection),
      maker: ethers.getAddress(a.maker),
      tokenId: a.anyToken ? null : a.tokenId.toString(),
      amount: BigInt(a.amount),
    });
  }
  return out;
}

/**
 * Announce a trade a wallet signed in wallet mode. Returns false when the hash
 * was already announced, the transaction did not succeed, or it is older than
 * NOTICE_WINDOW_S: every trade from before this path existed is unclaimed, and
 * handing one over must not message its accounts again. Notice failures are
 * logged, never thrown: the trade has happened either way.
 */
export async function noticeWalletTrade(args: {
  provider: ethers.Provider;
  txHash: string;
  marketAddress: string;
  siteUrl: string;
  supabase?: Db;
}): Promise<boolean> {
  const supabase = args.supabase ?? getSupabase();
  const receipt = await args.provider.getTransactionReceipt(args.txHash);
  if (!receipt || receipt.status !== 1) return false;
  const block = await args.provider.getBlock(receipt.blockNumber);
  if (!block || Date.now() / 1000 - block.timestamp > NOTICE_WINDOW_S) return false;
  if (!(await claimNotice(supabase, args.txHash))) return false;

  // Nobody here saw the result on the site as a Flizy account, so both sides of a sale hear.
  await noticeSales({ provider: args.provider, txHash: args.txHash, marketAddress: args.marketAddress, actorAccountId: null, siteUrl: args.siteUrl });

  for (const offer of offersInReceipt(receipt, args.marketAddress)) {
    // A collection offer names no one token, so it has no single owner to tell.
    if (!offer.tokenId) continue;
    try {
      const nft = new ethers.Contract(offer.collection, NFT_ABI, args.provider);
      const owner = await nft.ownerOf(offer.tokenId).catch(() => null);
      if (!owner) continue;
      const { data: account } = await supabase
        .from('accounts')
        .select('id')
        .ilike('agent_wallet_address', String(owner).toLowerCase())
        .maybeSingle();
      if (!account?.id) continue;
      const name = await nft.name().catch(() => null);
      await notifyAllChannels(
        account.id,
        formatOfferReceived({
          amountEth: ethFromWei(offer.amount) ?? ethers.formatEther(offer.amount),
          nftLabel: `${typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'NFT'} #${offer.tokenId}`,
          fromLabel: `an outside wallet (${offer.maker.slice(0, 6)}...${offer.maker.slice(-4)})`,
          itemUrl: `${args.siteUrl}/dashboard/explore/nfts/${offer.collection}/${offer.tokenId}`,
        })
      );
    } catch {
      console.warn('[market] wallet-mode offer notice was not queued');
    }
  }
  return true;
}
