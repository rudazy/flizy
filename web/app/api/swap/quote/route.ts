import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import {
  getWebChain,
  getDexAddresses,
  resolveToken,
  tokenLabel,
  quoteSwap,
  getFlzPrice,
} from '../../../../lib/dexServer';

export async function GET(req: Request) {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const url = new URL(req.url);
    const amount = url.searchParams.get('amount') || '';
    const tokenInRaw = url.searchParams.get('tokenIn') || 'ETH';
    const tokenOutRaw = url.searchParams.get('tokenOut') || 'FLZ';
    const side = url.searchParams.get('side') || '';

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const dex = getDexAddresses();

    if (side === 'price' || url.searchParams.get('price') === '1') {
      const px = await getFlzPrice(provider);
      return NextResponse.json({
        feeBps: dex.feeBpsDefault,
        price: px,
        chain: { id: chain.chainId, name: chain.name },
        tokens: { flz: dex.flz, weth: dex.wrappedNative, feeRouter: dex.feeRouter },
      });
    }

    let tokenIn: string | null;
    let tokenOut: string | null;
    if (side === 'buy') {
      tokenIn = null;
      tokenOut = resolveToken(tokenOutRaw === 'ETH' ? 'FLZ' : tokenOutRaw);
    } else if (side === 'sell') {
      tokenIn = resolveToken(tokenInRaw === 'ETH' ? 'FLZ' : tokenInRaw);
      tokenOut = null;
    } else {
      const inU = tokenInRaw.toUpperCase();
      const outU = tokenOutRaw.toUpperCase();
      tokenIn = inU === 'ETH' ? null : resolveToken(tokenInRaw);
      tokenOut = outU === 'ETH' ? null : resolveToken(tokenOutRaw);
    }

    const amountIn = ethers.parseEther(String(amount));
    if (amountIn <= 0n) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    const quote = await quoteSwap({
      provider,
      amountIn,
      tokenIn,
      tokenOut,
    });

    const feePct = `${(quote.feeBps / 100).toFixed(2)}%`;
    const poolFeeBps = 30;
    const allInBps = quote.feeBps + poolFeeBps;
    const allInPct = `${(allInBps / 100).toFixed(2)}%`;
    const slipPct = `${(quote.slippageBps / 100).toFixed(2)}%`;
    const inLabel = tokenLabel(tokenIn);
    const outLabel = tokenLabel(tokenOut);

    return NextResponse.json({
      amountIn: ethers.formatEther(amountIn),
      amountOut: ethers.formatEther(quote.amountOut),
      amountOutMin: ethers.formatEther(quote.amountOutMin),
      fee: ethers.formatEther(quote.feeAmount),
      feeBps: quote.feeBps,
      feePct,
      poolFeeBps,
      poolFeePct: '0.30%',
      allInBps,
      allInPct,
      slippageBps: quote.slippageBps,
      slippagePct: slipPct,
      tokenIn: inLabel,
      tokenOut: outLabel,
      feeRouter: quote.feeRouter,
      chain: { id: chain.chainId, name: chain.name },
      disclosure: `All-in ~${allInPct}: protocol ${feePct} + pool 0.30%. Protocol takes ~${ethers.formatEther(quote.feeAmount)} ${inLabel} before the swap. Network gas is extra.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Quote failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
