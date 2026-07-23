import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { executeSwap, resolveToken, getDexConfig, quoteSwap, isAllowedSwapRouter } =
  require('../../../../../lib/dex');
const { getDefaultChain, explorerTxUrl } = require('../../../../../lib/chains');
const { evaluateSwapPolicy } = require('../../../../../lib/engine/policy');
const { createSwapIntent } = require('../../../../../lib/engine/intent');

function deriveAgentWallet(accountId: string) {
  const material = ethers.keccak256(ethers.toUtf8Bytes(`flizy:agent:v1:${accountId}`));
  return new ethers.Wallet(material);
}

export async function POST(req: Request) {
  try {
    const accountId = getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const amount = String(body.amount || '');
    const side = String(body.side || 'swap');
    const tokenInRaw = String(body.tokenIn || 'ETH');
    const tokenOutRaw = String(body.tokenOut || 'FLZ');

    const chain = getDefaultChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
    const dex = getDexConfig(chain.id);
    if (!dex.feeRouter) {
      return NextResponse.json({ error: 'DEX not configured' }, { status: 500 });
    }

    let tokenIn: string | null;
    let tokenOut: string | null;
    if (side === 'buy') {
      tokenIn = null;
      tokenOut = resolveToken(tokenOutRaw === 'ETH' ? 'FLZ' : tokenOutRaw, chain.id);
    } else if (side === 'sell') {
      tokenIn = resolveToken(tokenInRaw === 'ETH' ? 'FLZ' : tokenInRaw, chain.id);
      tokenOut = null;
    } else {
      tokenIn = tokenInRaw.toUpperCase() === 'ETH' ? null : resolveToken(tokenInRaw, chain.id);
      tokenOut = tokenOutRaw.toUpperCase() === 'ETH' ? null : resolveToken(tokenOutRaw, chain.id);
    }

    const amountIn = ethers.parseEther(amount);
    if (amountIn <= 0n) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }

    if (!isAllowedSwapRouter(dex.feeRouter, chain.id)) {
      return NextResponse.json({ error: 'Router not allowlisted' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: account } = await supabase
      .from('accounts')
      .select('id, unlock_pin_hash, is_admin')
      .eq('id', accountId)
      .single();
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    const intent = createSwapIntent({
      actor: {
        accountId,
        waSenderId: 'web',
        isAdmin: Boolean(account.is_admin),
        sessionUnlocked: true,
        hasPin: Boolean(account.unlock_pin_hash),
      },
      side,
      amountIn: amount,
      tokenIn,
      tokenOut,
      routerAddress: dex.feeRouter,
      chainId: chain.id,
    });

    // Web session cookie is the unlock for site actions (PIN already gates dashboard).
    const policy = await evaluateSwapPolicy(intent, { requireUnlock: false });
    if (policy.decision === 'DENY') {
      return NextResponse.json({ error: policy.message || 'Denied' }, { status: 403 });
    }

    const quote = await quoteSwap({
      provider,
      amountIn,
      tokenIn,
      tokenOut,
      chainKey: chain.id,
    });

    const signer = deriveAgentWallet(accountId).connect(provider);
    const result = await executeSwap({
      signer,
      amountIn,
      tokenIn,
      tokenOut,
      amountOutMinWei: quote.amountOutMin,
      chainKey: chain.id,
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
