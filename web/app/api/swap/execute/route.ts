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
  tokenLabel,
} from '../../../../lib/dexServer';
import { apiErrorBody } from '../../../../lib/apiError';
import { maybeMarkFirstTx } from '../../../../lib/invite.ts';
import { tryAccountTxLock, releaseAccountTxLock } from '../../../../lib/accountTxLock.ts';
import { pointerIsGator } from '../../../../lib/gatorExecute.ts';
import { predictGatorAddress } from '../../../../lib/gatorAccount.ts';
import { gatorFailure, markTransferSubmitted } from '../../../../lib/gatorOutcome.ts';
import { outcomeUnknown } from '../../../../lib/gatorExecute.ts';
import { UNVERIFIED_REFUSAL, bindAmountOutMin, isUnverifiedSwap, parseSlippageBps } from '../../../../lib/swapGate.ts';
import { ammoraEnabled } from '../../../../lib/ammora/venue.ts';
import { ammoraSiteExecute } from '../../../../lib/ammora/siteSwap.ts';
import { ClientError, apiErrorBodyAllowingClientError } from '../../../../lib/apiError';

const ROUTE = 'POST /api/swap/execute';

/** An Ammora swap re-quotes, then sends approvals and the swap as UserOps. */
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json();
    const supabase = getSupabase();

    // Flizy's pools trade verified tokens only (web/lib/swapGate.ts). A swap
    // pays nobody: the output lands in this wallet, so on testnet it takes no
    // PIN, here or on Ammora. What guards it is the session, same-origin, the
    // reviewed minimum, the 5% slippage cap and the account lock. The hourly
    // cap stays as a churn limit.
    const rate = await checkSwapRateLimit(supabase, accountId);
    if (!rate.ok) {
      return NextResponse.json({ error: rate.error, code: rate.code }, { status: rate.status });
    }
    if (body.venue === 'ammora') return ammoraSwap(supabase, accountId, body);

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

    // Before any chain read: a token Flizy has not verified is never traded here.
    if (isUnverifiedSwap([tokenIn, tokenOut], dex)) {
      return NextResponse.json({ error: UNVERIFIED_REFUSAL, code: 'UNVERIFIED_TOKEN' }, { status: 400 });
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

    // The slippage picked on screen. The reviewed minimum above already binds
    // the fill; this keeps the server's own floor at the same tolerance.
    let slippageBps: number | undefined;
    try {
      slippageBps = parseSlippageBps(body.slippageBps);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
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
      slippageBps,
    });
    if (confirmedMin != null && quote.amountOut < confirmedMin) {
      return NextResponse.json(
        { error: 'The price moved since you reviewed it. Review the trade again.' },
        { status: 409 }
      );
    }
    const floor = bindAmountOutMin(quote.amountOutMin, confirmedMin);

    // From the resolved sides, so a token picked by address logs as MAKI, not its address.
    const inLabel = tokenLabel(tokenIn);
    const outLabel = tokenLabel(tokenOut);
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
            // Recorded before broadcast; with no row to record on, nothing is sent.
            onBroadcast: async (hash) => {
              if (!logRow?.id) throw new Error('no transfer row');
              await markTransferSubmitted(supabase, logRow.id, hash);
            },
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
      // Unknown outcome: the row stays 'submitted' for the reconciler.
      if (logRow?.id && !outcomeUnknown(swapErr)) {
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
    // to the transfers row and the journal; the client is told a swap failed,
    // or gets the executor's fixed copy (refused, or sent and still confirming).
    const executorOutcome = gatorFailure(err);
    if (executorOutcome) return NextResponse.json(executorOutcome.body, { status: executorOutcome.status });
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}

/**
 * An Ammora swap (lib/ammora). Same gates as a Flizy swap: same-origin, the
 * hourly cap above and the account lock, and no PIN on testnet. The venue's
 * own rules (attested code, a tradable token, the reviewed minimum, the pinned
 * router and its decoded calldata) are applied in ammoraSiteExecute before
 * anything is sent.
 */
async function ammoraSwap(
  supabase: ReturnType<typeof getSupabase>,
  accountId: string,
  body: Record<string, unknown>
) {
  if (!ammoraEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const side = body.side === 'sell' ? 'sell' : body.side === 'buy' ? 'buy' : null;
  if (!side) return NextResponse.json({ error: 'Choose buy or sell.' }, { status: 400 });
  let slippageBps: number | undefined;
  try {
    slippageBps = parseSlippageBps(body.slippageBps);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const chain = getWebChain();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const { data: account } = await supabase.from('accounts').select('id, agent_wallet_address').eq('id', accountId).single();
  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  const gator = pointerIsGator(accountId, account.agent_wallet_address) ? predictGatorAddress(accountId) : null;

  const lock = await tryAccountTxLock(supabase, accountId, 'swap');
  if (!lock.ok) return NextResponse.json({ error: lock.error }, { status: 409 });
  try {
    const out = await ammoraSiteExecute(supabase, provider, {
      accountId,
      chainId: chain.chainId,
      gator,
      side,
      token: String(body.token || ''),
      amount: String(body.amount || ''),
      slippageBps,
      confirmedMin: body.minOut == null ? null : String(body.minOut),
    });
    return NextResponse.json({ ok: true, ...out, explorerUrl: explorerTxUrl(chain, out.txHash) });
  } catch (err) {
    const executorOutcome = gatorFailure(err);
    if (executorOutcome) return NextResponse.json(executorOutcome.body, { status: executorOutcome.status });
    if (err instanceof ClientError) return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  } finally {
    await releaseAccountTxLock(supabase, accountId);
  }
}
