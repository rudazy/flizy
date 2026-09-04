import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { checkSwapRateLimit } from '../../../../lib/swapRateLimit.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import {
  getWebChain,
  getDexAddresses,
  resolveToken,
  quoteSwap,
  executeSwap,
  executeSwapViaGator,
  deriveAgentWallet,
  explorerTxUrl,
  assertSwapAllowed,
} from '../../../../lib/dexServer';
import { apiErrorBody } from '../../../../lib/apiError';
import { maybeMarkFirstTx } from '../../../../lib/invite.ts';
import { tryAccountTxLock, releaseAccountTxLock } from '../../../../lib/accountTxLock.ts';
import { pointerIsGator } from '../../../../lib/gatorExecute.ts';
import { predictGatorAddress } from '../../../../lib/gatorAccount.ts';

const ROUTE = 'POST /api/swap/execute';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const supabase = getSupabase();

    // No password gate here, unlike every other money route. A swap sends its
    // output to `recipient: signer.address` below and takes no slippage from the
    // caller, so it cannot move value off this account — only change what the
    // account holds. What is left to defend against is churn, which is what the
    // hourly cap is for. See web/lib/swapRateLimit.ts for the full argument.
    const rate = await checkSwapRateLimit(supabase, accountId);
    if (!rate.ok) {
      return NextResponse.json({ error: rate.error, code: rate.code }, { status: rate.status });
    }
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

    const { data: account } = await supabase
      .from('accounts')
      .select('id, agent_wallet_address')
      .eq('id', accountId)
      .single();
    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    const lock = await tryAccountTxLock(supabase, accountId, 'swap');
    if (!lock.ok) {
      return NextResponse.json({ error: lock.error }, { status: 409 });
    }

    try {
    const quote = await quoteSwap({
      provider,
      amountIn,
      tokenIn,
      tokenOut,
    });

    const inLabel = tokenInRaw.toUpperCase() === 'ETH' ? 'ETH' : tokenInRaw.toUpperCase();
    const outLabel = tokenOutRaw.toUpperCase() === 'ETH' ? 'ETH' : tokenOutRaw.toUpperCase();
    const amountOutStr = ethers.formatEther(quote.amountOut);

    // phone required on older schemas; 'site' marks dashboard-originated swaps
    const logPayload: Record<string, unknown> = {
      account_id: accountId,
      phone: 'site',
      to_address: dex.feeRouter,
      amount_eth: amount,
      status: 'pending',
      chain_id: chain.chainId,
      kind: 'swap',
      asset: inLabel,
      amount_secondary: amountOutStr,
      asset_secondary: outLabel,
      counterparty_label: `swap → ${outLabel}`,
      direction: 'out',
    };
    let logRow: { id: string } | null = null;
    {
      const first = await supabase.from('transfers').insert(logPayload).select('id').maybeSingle();
      if (first.error && /column|schema cache/i.test(first.error.message || '')) {
        const { asset, amount_secondary, asset_secondary, counterparty_label, direction, ...core } =
          logPayload;
        void asset;
        void amount_secondary;
        void asset_secondary;
        void counterparty_label;
        void direction;
        const retry = await supabase.from('transfers').insert(core).select('id').maybeSingle();
        logRow = retry.data;
      } else {
        logRow = first.data;
      }
    }

    try {
      // Funds sit on the gator once the pointer is flipped; the HMAC EOA is
      // only the owner that signs the UserOp. Mirrors lib/engine/executeSwap.js.
      const viaGator = pointerIsGator(accountId, account.agent_wallet_address);
      const signer = deriveAgentWallet(accountId).connect(provider);
      const walletAddr = viaGator ? predictGatorAddress(accountId) : signer.address;
      const result = viaGator
        ? await executeSwapViaGator({
            accountId,
            provider,
            chainId: chain.chainId,
            amountIn,
            tokenIn,
            tokenOut,
            amountOutMinWei: quote.amountOutMin,
            recipient: walletAddr,
          })
        : await executeSwap({
            signer,
            amountIn,
            tokenIn,
            tokenOut,
            amountOutMinWei: quote.amountOutMin,
            recipient: signer.address,
          });

      if (logRow?.id) {
        await supabase
          .from('transfers')
          .update({ status: 'confirmed', tx_hash: result.txHash })
          .eq('id', logRow.id);
      }

      try {
        const kind = side === 'buy' || side === 'sell' ? side : 'swap';
        await maybeMarkFirstTx(supabase, {
          accountId,
          kind,
          amount,
          ok: true,
        });
      } catch (hookErr) {
        console.warn(
          '[invite] first tx hook:',
          hookErr instanceof Error ? hookErr.message : hookErr
        );
      }

      const feePct = `${(quote.feeBps / 100).toFixed(2)}%`;
      const allInPct = `${((quote.feeBps + 30) / 100).toFixed(2)}%`;

      return NextResponse.json({
        ok: true,
        txHash: result.txHash,
        explorerUrl: explorerTxUrl(chain, result.txHash),
        fee: ethers.formatEther(quote.feeAmount),
        feeBps: quote.feeBps,
        feePct,
        allInPct,
        amountOut: amountOutStr,
        disclosure: `All-in ~${allInPct} (protocol ${feePct} + pool 0.30%). Network gas extra.`,
      });
    } catch (swapErr) {
      if (logRow?.id) {
        await supabase
          .from('transfers')
          .update({
            status: 'failed',
            error: swapErr instanceof Error ? swapErr.message : 'swap failed',
          })
          .eq('id', logRow.id);
      }
      throw swapErr;
    }
    } finally {
      await releaseAccountTxLock(supabase, accountId);
    }
  } catch (err) {
    // Covers the rethrown swap failure above. The full revert reason is written
    // to the transfers row and the journal; the client is told a swap failed.
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
