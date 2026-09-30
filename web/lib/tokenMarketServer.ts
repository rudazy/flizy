/**
 * Spot price and swap prints for the one token Flizy lists.
 *
 * FLZ against ETH on the Flizy pool. No other symbol is accepted by the
 * route that calls this, so the handler cannot be aimed at an arbitrary
 * contract. Dollar marks are not computed here.
 */

import { ethers } from 'ethers';
import { getDexAddresses, getWebChain } from './dexServer';
import {
  buildCandles,
  bucketForRange,
  changePct,
  printFromSwap,
  rangeSeconds,
  sumVolume,
  type Candle,
  type ChartRange,
  type Print,
} from './tokenMarket';

const SWAP_ABI = [
  'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ERC20_ABI = [
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
];

const iface = new ethers.Interface(SWAP_ABI);

export type TokenSnapshot = {
  symbol: 'FLZ';
  name: string;
  address: string;
  pair: string;
  chainName: string;
  explorerBaseUrl: string;
  priceEth: string | null;
  flzPerEth: string | null;
  reserveEth: string | null;
  reserveFlz: string | null;
  marketCapEth: string | null;
  liquidityEth: string | null;
  change1hPct: number | null;
  volumeEth: string | null;
  trades: number | null;
  candles: Candle[];
  chartError: boolean;
};

function blockSpan(range: ChartRange): number {
  if (range === 'live') return 2_000;
  if (range === '1h') return 5_000;
  if (range === '4h') return 20_000;
  return 50_000;
}

async function swapLogs(provider: ethers.JsonRpcProvider, pair: string, span: number) {
  const contract = new ethers.Contract(pair, SWAP_ABI, provider);
  const latest = await provider.getBlockNumber();
  let width = span;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const from = Math.max(0, latest - width);
    try {
      return await contract.queryFilter(contract.filters.Swap(), from, latest);
    } catch (err) {
      lastError = err;
      width = Math.floor(width / 4);
      if (width < 200) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('swap logs unavailable');
}

function inWindow(prints: Print[], now: number, seconds: number | null): Print[] {
  if (seconds == null) return prints;
  const start = now - seconds;
  return prints.filter((print) => print.time >= start);
}

export async function loadFlzMarket(range: ChartRange): Promise<TokenSnapshot> {
  const chain = getWebChain();
  const dex = getDexAddresses();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const snapshot: TokenSnapshot = {
    symbol: 'FLZ',
    name: 'FLZ',
    address: dex.flz,
    pair: dex.pair,
    chainName: chain.name,
    explorerBaseUrl: chain.explorerBaseUrl,
    priceEth: null,
    flzPerEth: null,
    reserveEth: null,
    reserveFlz: null,
    marketCapEth: null,
    liquidityEth: null,
    change1hPct: null,
    volumeEth: null,
    trades: null,
    candles: [],
    chartError: false,
  };

  const pair = new ethers.Contract(dex.pair, SWAP_ABI, provider);
  try {
    const [reserves, token0, supply, tokenName] = await Promise.all([
      pair.getReserves() as Promise<[bigint, bigint, number]>,
      pair.token0() as Promise<string>,
      new ethers.Contract(dex.flz, ERC20_ABI, provider).totalSupply() as Promise<bigint>,
      new ethers.Contract(dex.flz, ERC20_ABI, provider).name().catch(() => 'FLZ') as Promise<string>,
    ]);
    const flzIs0 = ethers.getAddress(String(token0)) === dex.flz;
    const reserveFlz = flzIs0 ? reserves[0] : reserves[1];
    const reserveEth = flzIs0 ? reserves[1] : reserves[0];
    snapshot.name = tokenName || 'FLZ';
    snapshot.reserveFlz = ethers.formatEther(reserveFlz);
    snapshot.reserveEth = ethers.formatEther(reserveEth);
    if (reserveEth > 0n && reserveFlz > 0n) {
      const one = ethers.parseEther('1');
      snapshot.priceEth = ethers.formatEther((reserveEth * one) / reserveFlz);
      snapshot.flzPerEth = ethers.formatEther((reserveFlz * one) / reserveEth);
      snapshot.liquidityEth = ethers.formatEther(reserveEth);
      if (supply > 0n) snapshot.marketCapEth = ethers.formatEther((reserveEth * supply) / reserveFlz);
    }
  } catch {
    return { ...snapshot, chartError: true };
  }

  try {
    const logs = (await swapLogs(provider, dex.pair, Math.max(blockSpan(range), blockSpan('1h')))).slice(-400);
    const token0 = await pair.token0();
    const flzIs0 = ethers.getAddress(String(token0)) === dex.flz;
    const blockNumbers = [...new Set(logs.map((log) => log.blockNumber))].slice(-120);
    const times = new Map<number, number>();
    for (let i = 0; i < blockNumbers.length; i += 8) {
      const slice = blockNumbers.slice(i, i + 8);
      await Promise.all(
        slice.map(async (blockNumber) => {
          const block = await provider.getBlock(blockNumber);
          if (block) times.set(blockNumber, block.timestamp);
        })
      );
    }
    const prints: Print[] = [];
    for (const log of logs) {
      const time = times.get(log.blockNumber);
      if (time == null) continue;
      let parsed: ethers.LogDescription | null = null;
      try {
        parsed = iface.parseLog(log);
      } catch {
        parsed = null;
      }
      if (!parsed || parsed.name !== 'Swap') continue;
      const print = printFromSwap({
        flzIsToken0: flzIs0,
        amount0In: parsed.args.amount0In as bigint,
        amount1In: parsed.args.amount1In as bigint,
        amount0Out: parsed.args.amount0Out as bigint,
        amount1Out: parsed.args.amount1Out as bigint,
        time,
      });
      if (print) prints.push(print);
    }
    const head = await provider.getBlock('latest');
    const now = head?.timestamp ?? Math.floor(Date.now() / 1000);
    const windowPrints = inWindow(prints, now, rangeSeconds(range));
    const hourPrints = inWindow(prints, now, rangeSeconds('1h'));
    snapshot.change1hPct = changePct(hourPrints);
    snapshot.volumeEth = String(sumVolume(windowPrints));
    snapshot.trades = windowPrints.length;
    snapshot.candles = buildCandles(windowPrints, bucketForRange(range));
  } catch {
    snapshot.chartError = true;
  }

  return snapshot;
}
