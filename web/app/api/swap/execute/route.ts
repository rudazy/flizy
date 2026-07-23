import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import {
  getWebChain,
  getDexAddresses,
  resolveToken,
  quoteSwap,
  executeSwap,
  deriveAgentWallet,
  explorerTxUrl,
  assertSwapAllowed,
} from '../../../../lib/dexServer';

export async function POST(req: Request) {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const amount = String(body.amount || '');
    const side = String(body.side || 'swap');
    const tokenInRaw = String(body.tokenIn || 'ETH');
    const tokenOutRaw = String(body.tokenOut || 'FLZ');

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const dex = getDexAddresses();

    const gate = assertSwapAllowed(accountId, dex.feeRouter);
    if (!gate.ok) {
      return NextResponse.json({ error: gate.message }, { status: 403 });
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
      tokenIn = tokenInRaw.toUpperCase() === 'ETH' ? null : resolveToken(tokenInRaw);
      tokenOut = tokenOutRaw.toUpperCase() === 'ETH' ? null : resolveToken(tokenOutRaw);
    }

    const amountIn = ethers.parseEther(amount);
    if (amountIn <= 0n) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: account } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', accountId)
      .single();
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    const quote = await quoteSwap({
      provider,
      amountIn,
      tokenIn,
      tokenOut,
    });

    const signer = deriveAgentWallet(accountId).connect(provider);
    const result = await executeSwap({
      signer,
      amountIn,
      tokenIn,
      tokenOut,
      amountOutMinWei: quote.amountOutMin,
      recipient: signer.address,
    });

    return NextResponse.json({
      ok: true,
      txHash: result.txHash,
      explorerUrl: explorerTxUrl(chain, result.txHash),
      fee: ethers.formatEther(quote.feeAmount),
      feeBps: quote.feeBps,
      feePct: `${(quote.feeBps / 100).toFixed(2)}%`,
      amountOut: ethers.formatEther(quote.amountOut),
      disclosure: `Protocol fee ${(quote.feeBps / 100).toFixed(2)}% applied before swap.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Swap failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
