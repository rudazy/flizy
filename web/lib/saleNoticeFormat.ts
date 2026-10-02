/**
 * Wording and decoding for NFT sale notices, with no database or network, so
 * node --test can load it directly. The sending half is web/lib/saleNotice.ts.
 *
 * Same wording as lib/saleNotice.js (the bots' copy, used when an offer is
 * accepted from chat); test/saleNotice.test.js builds both from the same input
 * and requires identical text. Written to the outbox, so no {{cmd:}} markers.
 */

import { ethers } from 'ethers';
import { displaySafeLabel } from './sanitize.ts';

const SOLD_IFACE = new ethers.Interface([
  'event Sold(address indexed collection, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price, uint256 fee, uint256 royalty, uint256 offerId)',
]);

function clean(raw: string, fallback: string, max = 60): string {
  return displaySafeLabel(String(raw || '').replace(/[{}]/g, ''), max) || fallback;
}

/** "0.049" style ETH for a wei amount: up to 6 places, trailing zeros dropped. */
function eth(wei: bigint): string {
  const text = ethers.formatEther(wei);
  const [whole, frac = ''] = text.split('.');
  const cut = frac.slice(0, 6).replace(/0+$/, '');
  return cut ? `${whole}.${cut}` : whole;
}

export function formatSaleNotices(p: {
  nft: string;
  price: bigint | string;
  fee: bigint | string;
  royalty: bigint | string;
  sellerLabel: string;
  buyerLabel: string;
  viaOffer: boolean;
  itemUrl: string;
}): { seller: string; buyer: string } {
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

type SoldEvent = {
  collection: string;
  tokenId: string;
  buyer: string;
  seller: string;
  price: bigint;
  fee: bigint;
  royalty: bigint;
  viaOffer: boolean;
};

/** Sold events the marketplace emitted in a receipt, decoded. */
export function soldEvents(receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> } | null, marketAddress: string): SoldEvent[] {
  const market = ethers.getAddress(marketAddress);
  const out: SoldEvent[] = [];
  for (const log of receipt?.logs ?? []) {
    if (!log.address || ethers.getAddress(log.address) !== market) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = SOLD_IFACE.parseLog({ topics: [...log.topics], data: log.data });
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

