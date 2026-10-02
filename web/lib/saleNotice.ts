/**
 * Chat messages for a completed NFT sale: one for the seller, one for the
 * buyer, built from the marketplace's Sold event so the figures are what the
 * contract paid. The wording lives in web/lib/saleNoticeFormat.ts.
 */

import { ethers } from 'ethers';
import { getSupabase } from './supabase';
import { notifyAllChannels } from './notifyChannels';
import { formatSaleNotices, soldEvents } from './saleNoticeFormat.ts';

const NAME_ABI = ['function name() view returns (string)'];

/**
 * Tell the seller and the buyer of every sale in `txHash`, on all their chats,
 * except `actorAccountId`, who already saw the result on the site. Never throws:
 * the sale has happened, and a notice that fails is only logged.
 */
export async function noticeSales(args: {
  provider: ethers.Provider;
  txHash: string;
  marketAddress: string;
  actorAccountId: string;
  siteUrl: string;
}): Promise<void> {
  try {
    const receipt = await args.provider.getTransactionReceipt(args.txHash);
    const supabase = getSupabase();
    const lookup = async (address: string) => {
      const { data } = await supabase
        .from('accounts')
        .select('id, username')
        .ilike('agent_wallet_address', address.toLowerCase())
        .maybeSingle();
      return (data as { id: string; username: string | null } | null) ?? null;
    };
    const label = (acc: { username: string | null } | null, address: string) =>
      acc?.username ? `@${acc.username}` : `${address.slice(0, 6)}...${address.slice(-4)}`;
    for (const sale of soldEvents(receipt, args.marketAddress)) {
      const [sellerAcc, buyerAcc] = await Promise.all([lookup(sale.seller), lookup(sale.buyer)]);
      const name = await new ethers.Contract(sale.collection, NAME_ABI, args.provider).name().catch(() => null);
      const text = formatSaleNotices({
        nft: `${typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'NFT'} #${sale.tokenId}`,
        price: sale.price,
        fee: sale.fee,
        royalty: sale.royalty,
        sellerLabel: label(sellerAcc, sale.seller),
        buyerLabel: label(buyerAcc, sale.buyer),
        viaOffer: sale.viaOffer,
        itemUrl: `${args.siteUrl}/dashboard/explore/nfts/${sale.collection}/${sale.tokenId}`,
      });
      if (sellerAcc && sellerAcc.id !== args.actorAccountId) await notifyAllChannels(sellerAcc.id, text.seller);
      if (buyerAcc && buyerAcc.id !== args.actorAccountId) await notifyAllChannels(buyerAcc.id, text.buyer);
    }
  } catch {
    console.warn('[market] sale notice was not queued');
  }
}
