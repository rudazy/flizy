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
  readErc20Decimals,
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
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { bindAmountOutMin, swapNeedsPassword } from '../../../../lib/swapGate.ts';

const ROUTE = 'POST /api/swap/execute';

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const supabase = getSupabase();

    // ETH/FLZ swaps take no password: the only pool on that pair is the one
    // Flizy controls, so the worst a stolen session can do is churn, which the
    // hourly cap is for. Any other token needs the password, checked below once
    // the sides are resolved. web/lib/swapGate.ts has the reason.
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
    if (tokenIn !== null && tokenOut !== null) {
      return NextResponse.json(
        { error: 'Token-to-token swaps are not available. Use buy or sell.' },
        { status: 400 }
      );
    }

    if (swapNeedsPassword([tokenIn, tokenOut], dex)) {
      const auth = await requirePassword(
        supabase,
        accountId,
        String(body.password || ''),
        'trade a token Flizy has not verified'
      );
      if (!auth.ok) {
        return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
      }
    }

    const inDecimals = await readErc20Decimals(provider, tokenIn);
    const outDecimals = await readErc20Decimals(provider, tokenOut);
    let amountIn: bigint;
    try {
      amountIn = ethers.parseUnits(amount, inDecimals);
    } catch {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    if (amountIn <= 0n) {
      return NextResponse.json({ error: 'Invalid amount' }, { status: 400 });
    }
    // The minimum shown on the review step. Optional so an older open tab still
    // works, in which case the server's own quote sets the floor.
    let confirmedMin: bigint | null = null;
    if (body.minOut != null && String(body.minOut).trim() !== '') {
      try {
        confirmedMin = ethers.parseUnits(String(body.minOut), outDecimals);
      } catch {
        return NextResponse.json({ error: 'Invalid minimum' }, { status: 400 });
      }
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
    if (confirmedMin != null && quote.amountOut < confirmedMin) {
      return NextResponse.json(
        { error: 'The price moved since you reviewed it. Review the trade again.' },
        { status: 409 }
      );
    }
    const floor = bindAmountOutMin(quote.amountOutMin, confirmedMin);

    const inLabel = tokenInRaw.toUpperCase() === 'ETH' ? 'ETH' : tokenInRaw.toUpperCase();
    const outLabel = tokenOutRaw.toUpperCase() === 'ETH' ? 'ETH' : tokenOutRaw.toUpperCase();
    const amountOutStr = ethers.formatUnits(quote.amountOut, outDecimals);

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
            amountOutMinWei: floor,
            recipient: walletAddr,
          })
        : await executeSwap({
            signer,
            amountIn,
            tokenIn,
            tokenOut,
            amountOutMinWei: floor,
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
        fee: ethers.formatUnits(quote.feeAmount, inDecimals),
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
