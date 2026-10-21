import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import {
  getWebChain,
  getDexAddresses,
  resolveToken,
  tokenLabel,
  quoteSwap,
  getPoolPrice,
  readErc20Decimals,
} from '../../../../lib/dexServer';
import { apiErrorBody, apiErrorBodyAllowingClientError } from '../../../../lib/apiError';
import { getSupabase } from '../../../../lib/supabase';
import { anonymousReadLimit } from '../../../../lib/readLimit';
import { ammoraEnabled } from '../../../../lib/ammora/venue.ts';
import { ammoraSitePrice, ammoraSiteQuote } from '../../../../lib/ammora/siteSwap.ts';
import { asSwapQuoteError } from '../../../../lib/swapQuoteError';
import { UNVERIFIED_REFUSAL, isUnverifiedSwap, parseSlippageBps } from '../../../../lib/swapGate.ts';
import { listedBySymbol } from '../../../../lib/listedTokens.ts';

const ROUTE = 'GET /api/swap/quote';

/** An Ammora quote builds its route client on a cold instance (several seconds). */
export const maxDuration = 60;

/**
 * A rough gas figure for one Flizy swap, used only for the network fee
 * estimate the trade sheet shows. It is not a limit: the real cost depends on
 * the wallet path and the gas price when the trade lands.
 */
const SWAP_GAS_UNITS = 350_000n;

export async function GET(req: Request) {
  try {
    // Prices and quotes are public pool reads, so wallet mode can quote without
    // a Flizy session, capped per caller. The Ammora venue stays an account feature.
    const accountId = await getAccountIdFromCookie();
    const limited = await anonymousReadLimit(accountId);
    if (limited) return limited;
    const url = new URL(req.url);
    const amount = url.searchParams.get('amount') || '';
    const tokenInRaw = url.searchParams.get('tokenIn') || 'ETH';
    const tokenOutRaw = url.searchParams.get('tokenOut') || 'FLZ';
    const side = url.searchParams.get('side') || '';

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const dex = getDexAddresses();

    // Ammora venue (lib/ammora). Off: the request is refused before any Ammora call.
    if (url.searchParams.get('venue') === 'ammora') {
      if (!ammoraEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
      if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
      const token = url.searchParams.get('token') || '';
      if (side === 'price' || url.searchParams.get('price') === '1') {
        return NextResponse.json({ price: await ammoraSitePrice(getSupabase(), provider, token) });
      }
      if (side !== 'buy' && side !== 'sell') return NextResponse.json({ error: 'Choose buy or sell.' }, { status: 400 });
      const quote = await ammoraSiteQuote(getSupabase(), provider, {
        side,
        token,
        amount,
        slippageBps: parseSlippageBps(url.searchParams.get('slippageBps')),
      });
      return NextResponse.json(quote);
    }

    if (side === 'price' || url.searchParams.get('price') === '1') {
      const priceSymbol = (url.searchParams.get('token') || 'FLZ').trim().toUpperCase();
      if (priceSymbol !== 'FLZ' && !listedBySymbol(priceSymbol)) {
        return NextResponse.json({ error: 'No Flizy pool for that token.' }, { status: 400 });
      }
      const px = await getPoolPrice(provider, priceSymbol);
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
    if (isUnverifiedSwap([tokenIn, tokenOut], dex)) {
      return NextResponse.json({ error: UNVERIFIED_REFUSAL, code: 'UNVERIFIED_TOKEN' }, { status: 400 });
    }

    const inDecimals = await readErc20Decimals(provider, tokenIn);
    const outDecimals = await readErc20Decimals(provider, tokenOut);
    let amountIn: bigint;
    try {
      amountIn = ethers.parseUnits(String(amount), inDecimals);
    } catch {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    if (amountIn <= 0n) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    let slippageBps: number | undefined;
    try {
      slippageBps = parseSlippageBps(url.searchParams.get('slippageBps'));
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }

    const [quote, feeData] = await Promise.all([
      quoteSwap({
        provider,
        amountIn,
        tokenIn,
        tokenOut,
        slippageBps,
      }),
      provider.getFeeData().catch(() => null),
    ]);
    const gasPrice = feeData?.maxFeePerGas ?? feeData?.gasPrice ?? null;
    const networkFeeEth = gasPrice != null ? ethers.formatEther(gasPrice * SWAP_GAS_UNITS) : null;

    const feePct = `${(quote.feeBps / 100).toFixed(2)}%`;
    const poolFeeBps = 30;
    const allInBps = quote.feeBps + poolFeeBps;
    const allInPct = `${(allInBps / 100).toFixed(2)}%`;
    const slipPct = `${(quote.slippageBps / 100).toFixed(2)}%`;
    const inLabel = tokenLabel(tokenIn);
    const outLabel = tokenLabel(tokenOut);

    return NextResponse.json({
      amountIn: ethers.formatUnits(amountIn, inDecimals),
      amountOut: ethers.formatUnits(quote.amountOut, outDecimals),
      amountOutMin: ethers.formatUnits(quote.amountOutMin, outDecimals),
      fee: ethers.formatUnits(quote.feeAmount, inDecimals),
      feeBps: quote.feeBps,
      feePct,
      poolFeeBps,
      poolFeePct: '0.30%',
      allInBps,
      allInPct,
      slippageBps: quote.slippageBps,
      slippagePct: slipPct,
      // An estimate from the current gas price, or null when it could not be read.
      networkFeeEth,
      tokenIn: inLabel,
      tokenOut: outLabel,
      feeRouter: quote.feeRouter,
      // Raw figures and the route, for a wallet-mode swap the visitor's own wallet signs.
      path: quote.path,
      amountInUnits: amountIn.toString(),
      amountOutMinUnits: quote.amountOutMin.toString(),
      chain: { id: chain.chainId, name: chain.name },
      disclosure: `All-in ~${allInPct}: protocol ${feePct} + pool 0.30%. Protocol takes ~${ethers.formatUnits(quote.feeAmount, inDecimals)} ${inLabel} before the swap. Network gas is extra.`,
    });
  } catch (err) {
    const client = asSwapQuoteError(err);
    if (client) {
      return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, client), { status: 400 });
    }
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
