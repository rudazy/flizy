/**
 * Listed NFT collections for identity send / wallet display.
 * Mirrors lib/listedNfts.js env parse. Empty env falls back to the testnet giwaforge.
 */

import { ethers } from 'ethers';

const DEFAULT_GIWAFORGE = '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A';

const ERC721_META_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

export type ListedNft = { ticker: string; address: string };

export type NftHolding = {
  ticker: string;
  address: string;
  balance: string | null;
  ids: string[];
  error?: string;
};

export function parseNftRegistry(raw: string): ListedNft[] {
  const out: ListedNft[] = [];
  const seen = new Set<string>();
  for (const part of String(raw || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const idx = s.indexOf(':');
    if (idx <= 0) continue;
    const ticker = s.slice(0, idx).trim().toLowerCase();
    const addr = s.slice(idx + 1).trim();
    if (!/^[a-z][a-z0-9]{0,31}$/.test(ticker)) continue;
    if (!ethers.isAddress(addr)) continue;
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, address: ethers.getAddress(addr) });
  }
  return out;
}

export function listedNfts(): ListedNft[] {
  const fromEnv = parseNftRegistry(process.env.CHAIN_GIWA_SEPOLIA_NFTS || '');
  if (fromEnv.length) return fromEnv;
  return [{ ticker: 'giwaforge', address: ethers.getAddress(DEFAULT_GIWAFORGE) }];
}

export async function loadNftHoldings(
  provider: ethers.Provider,
  wallet: string
): Promise<NftHolding[]> {
  const out: NftHolding[] = [];
  for (const col of listedNfts()) {
    try {
      const nft = new ethers.Contract(col.address, ERC721_META_ABI, provider);
      const bal = await nft.balanceOf(wallet);
      const count = Number(bal);
      let ids: string[] = [];
      if (count > 0) {
        try {
          const incoming = await nft.queryFilter(nft.filters.Transfer(null, wallet));
          const owned = new Set<string>();
          for (const ev of incoming) {
            if (!('args' in ev) || ev.args?.tokenId == null) continue;
            owned.add(ev.args.tokenId.toString());
          }
          const outgoing = await nft.queryFilter(nft.filters.Transfer(wallet, null));
          for (const ev of outgoing) {
            if (!('args' in ev) || ev.args?.tokenId == null) continue;
            owned.delete(ev.args.tokenId.toString());
          }
          ids = [...owned].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        } catch {
          ids = [];
        }
      }
      out.push({
        ticker: col.ticker,
        address: col.address,
        balance: String(count),
        ids,
      });
    } catch {
      out.push({
        ticker: col.ticker,
        address: col.address,
        balance: null,
        ids: [],
        error: 'Could not read NFT',
      });
    }
  }
  return out;
}

export function formatNftHoldingLine(n: NftHolding): string {
  if (n.balance == null) return `${n.ticker}: unavailable`;
  if (n.ids.length) return `${n.ticker} ${n.ids.map((id) => `#${id}`).join(', ')}`;
  return `${n.ticker}: ${n.balance}`;
}
