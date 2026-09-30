/**
 * Top FLZ holders.
 *
 * The explorer lists addresses. Each balance and the supply are read from
 * the token before anything is shown. GIWA caps eth_getLogs, so this does
 * not scan Transfer logs.
 */

import { ethers } from 'ethers';
import { getDexAddresses, getWebChain } from './dexServer';
import { holderAddresses, holderCount, presentHolders, type HolderBalance, type HolderView } from './tokenHolders';

const ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

export type FlzHolders = {
  holders: HolderView[];
  topShare: string | null;
  count: number | null;
};

async function readJson(url: string): Promise<unknown> {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('holders unavailable');
  return res.json();
}

export async function loadFlzHolders(): Promise<FlzHolders> {
  const chain = getWebChain();
  const dex = getDexAddresses();
  if (!chain.explorerBaseUrl.startsWith('https://')) throw new Error('holders unavailable');
  const base = `${chain.explorerBaseUrl.replace(/\/$/, '')}/api/v2/tokens/${dex.flz}`;
  const [holdersBody, tokenBody] = await Promise.all([
    readJson(`${base}/holders`),
    readJson(base).catch(() => null),
  ]);
  const addresses = holderAddresses(holdersBody);
  if (addresses.length === 0) {
    return { holders: [], topShare: null, count: holderCount(tokenBody) };
  }

  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const token = new ethers.Contract(dex.flz, ABI, provider);
  const supply = BigInt(await token.totalSupply());
  const read = (
    await Promise.all(
      addresses.map(async (address): Promise<HolderBalance | null> => {
        try {
          return { address, balance: BigInt(await token.balanceOf(address)) };
        } catch {
          return null;
        }
      })
    )
  ).filter((row): row is HolderBalance => row != null);
  if (read.length === 0) throw new Error('holders unavailable');

  const presented = presentHolders(read, supply, dex.pair);
  return { ...presented, count: holderCount(tokenBody) };
}
