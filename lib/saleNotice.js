/**
 * Chat messages for a completed NFT sale: one for the seller, one for the
 * buyer. Built from the marketplace's Sold event, so the figures are what the
 * contract paid, not an estimate.
 *
 * Same wording as web/lib/saleNoticeFormat.ts (the site's copy); a test builds both
 * from the same input and requires identical text.
 */

const { ethers } = require('ethers');
const { displaySafeLabel, publicErrorMessage } = require('./sanitize');

const SOLD_ABI = [
  'event Sold(address indexed collection, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price, uint256 fee, uint256 royalty, uint256 offerId)',
];
const SOLD_IFACE = new ethers.Interface(SOLD_ABI);
const NAME_ABI = ['function name() view returns (string)'];

function clean(raw, fallback, max = 60) {
  return displaySafeLabel(String(raw || '').replace(/[{}]/g, ''), max) || fallback;
}

/** "0.049" style ETH for a wei amount: up to 6 places, trailing zeros dropped. */
function eth(wei) {
  const text = ethers.formatEther(BigInt(wei));
  const [whole, frac = ''] = text.split('.');
  const cut = frac.slice(0, 6).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

/**
 * @param {{ nft: string, price: bigint|string, fee: bigint|string, royalty: bigint|string,
 *   sellerLabel: string, buyerLabel: string, viaOffer: boolean, itemUrl: string }} p
 * @returns {{ seller: string, buyer: string }}
 */
function formatSaleNotices(p) {
  const nft = clean(p.nft, 'your NFT');
  const buyer = clean(p.buyerLabel, 'someone', 40);
  const seller = clean(p.sellerLabel, 'someone', 40);
  const price = BigInt(p.price);
  const fee = BigInt(p.fee);
  const royalty = BigInt(p.royalty);
  const received = price - fee - royalty;
  const deductions = royalty > 0n ? `the 2% Flizy fee and ${eth(royalty)} ETH creator royalty` : 'the 2% Flizy fee';
  return {
    seller: [
      `Sold: ${nft} for ${eth(price)} ETH to ${buyer}.`,
      `You received ${eth(received)} ETH after ${deductions}.`,
      '',
      `View it: ${p.itemUrl}`,
    ].join('\n'),
    buyer: [
      p.viaOffer
        ? `Your offer was accepted: ${nft} is yours for ${eth(price)} ETH, from ${seller}.`
        : `You bought ${nft} for ${eth(price)} ETH from ${seller}.`,
      '',
      `It is in your Flizy wallet: ${p.itemUrl}`,
    ].join('\n'),
  };
}

/** Sold events the marketplace emitted in a receipt, decoded. */
function soldEvents(receipt, marketAddress) {
  const market = ethers.getAddress(marketAddress);
  const out = [];
  for (const log of (receipt && receipt.logs) || []) {
    if (!log.address || ethers.getAddress(log.address) !== market) continue;
    let parsed = null;
    try {
      parsed = SOLD_IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.name !== 'Sold') continue;
    const a = parsed.args;
    out.push({
      collection: ethers.getAddress(a.collection),
      tokenId: a.tokenId.toString(),
      buyer: ethers.getAddress(a.buyer),
      seller: ethers.getAddress(a.seller),
      price: BigInt(a.price),
      fee: BigInt(a.fee),
      royalty: BigInt(a.royalty),
      viaOffer: a.offerId.toString() !== '0',
    });
  }
  return out;
}

/**
 * Tell the seller and the buyer of every sale in `txHash`, each on their own
 * chats, except `actorAccountId`, who already saw the result where they acted.
 * Never throws: the sale has happened, and a notice that fails is only logged.
 */
async function noticeSales({ provider, supabase, notifyAccount, txHash, marketAddress, actorAccountId, siteUrl }) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    for (const sale of soldEvents(receipt, marketAddress)) {
      const lookup = async (address) => {
        const { data } = await supabase
          .from('accounts')
          .select('id, username')
          .ilike('agent_wallet_address', address.toLowerCase())
          .maybeSingle();
        return data || null;
      };
      const [sellerAcc, buyerAcc] = await Promise.all([lookup(sale.seller), lookup(sale.buyer)]);
      const name = await new ethers.Contract(sale.collection, NAME_ABI, provider).name().catch(() => null);
      const label = (acc, address) => (acc && acc.username ? `@${acc.username}` : `${address.slice(0, 6)}...${address.slice(-4)}`);
      const text = formatSaleNotices({
        nft: `${typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : 'NFT'} #${sale.tokenId}`,
        price: sale.price,
        fee: sale.fee,
        royalty: sale.royalty,
        sellerLabel: label(sellerAcc, sale.seller),
        buyerLabel: label(buyerAcc, sale.buyer),
        viaOffer: sale.viaOffer,
        itemUrl: `${siteUrl}/dashboard/explore/nfts/${sale.collection}/${sale.tokenId}`,
      });
      if (sellerAcc && sellerAcc.id !== actorAccountId) await notifyAccount(sellerAcc.id, text.seller);
      if (buyerAcc && buyerAcc.id !== actorAccountId) await notifyAccount(buyerAcc.id, text.buyer);
    }
  } catch (err) {
    console.warn('[sale notice] not sent:', publicErrorMessage(err));
  }
}

module.exports = { formatSaleNotices, soldEvents, noticeSales };
