import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { requireStepUp } from '../../../../lib/stepUp.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { resolvePayRef } from '../../../../lib/payCode.ts';
import { deriveAgentWallet, executeSwap, executeSwapViaGator, explorerTxUrl, getWebChain } from '../../../../lib/dexServer';
import { apiErrorBody } from '../../../../lib/apiError';
import { tryAccountTxLock, releaseAccountTxLock } from '../../../../lib/accountTxLock.ts';
import { pointerIsGator, gatorGasReserveWei } from '../../../../lib/gatorExecute.ts';
import { predictGatorAddress } from '../../../../lib/gatorAccount.ts';
import { fundingWallText } from '../../../../lib/fundingWall.ts';
import { checkDailyNativeLimit } from '../../../../lib/dailyLimits.ts';
import { gatorFailure, markTransferSubmitted } from '../../../../lib/gatorOutcome.ts';
import { outcomeUnknown } from '../../../../lib/gatorExecute.ts';
import { notifyAllChannels } from '../../../../lib/notifyChannels';
import { formatPaymentReceived, payerLabel } from '../../../../lib/payNotice.ts';
import { siteOrigin } from '../../../../lib/siteOrigin';
import { symbolLabel } from '../../../../lib/listedTokens';
import { cleanPayNote } from '../../../../lib/payLink.ts';
import { quoteRefusal, quoteSwapPay, receivedInReceipt, type SwapPayAsset } from '../../../../lib/swapPay.ts';

const ROUTE = '/api/pay/swap';

/**
 * Pay a token amount with ETH: one swap through the fee router whose output
 * goes to the payee (web/lib/swapPay.ts). The payee is guaranteed the full
 * amount asked; the payer sends at most the quoted ETH.
 *
 * Same gates as POST /api/pay/execute, in the same order: same site, signed
 * in, the PIN (every time: a swap is never a quick send, so this is a step-up
 * route, not a tiered one), the account lock, the daily ETH limit for the ETH
 * leaving, and a transfers row written before broadcast.
 *
 * GET quotes, POST pays. Both name the payee by pay ref, never by address.
 */

function readAsset(raw: unknown): SwapPayAsset | null {
  const s = String(raw || '').trim().toUpperCase();
  if (s === 'TUSD' || s === 'USD') return 'TUSD';
  if (s === 'FLZ') return 'FLZ';
  return null;
}

function gasBufferWei(): bigint {
  try {
    return ethers.parseEther(String(process.env.GAS_BUFFER_ETH || '0.0001'));
  } catch {
    return ethers.parseEther('0.0001');
  }
}

export async function GET(req: Request) {
  try {
    if (!(await getAccountIdFromCookie())) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const params = new URL(req.url).searchParams;
    const asset = readAsset(params.get('asset'));
    if (!asset) return NextResponse.json({ error: 'Only FLZ and tUSD can be paid with ETH.' }, { status: 400 });
    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    let quote;
    try {
      quote = await quoteSwapPay(provider, asset, String(params.get('amount') || ''));
    } catch (err) {
      return NextResponse.json({ error: quoteRefusal(err) }, { status: 400 });
    }
    return NextResponse.json({
      asset,
      amount: ethers.formatUnits(quote.amountOut, quote.decimals),
      unit: symbolLabel(asset),
      maxEth: ethers.formatEther(quote.ethIn),
      feeBps: quote.feeBps,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(`GET ${ROUTE}`, err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const payerId = await getAccountIdFromCookie();
    if (!payerId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const supabase = getSupabase();
    const asset = readAsset(body.asset);
    if (!asset) return NextResponse.json({ error: 'Only FLZ and tUSD can be paid with ETH.' }, { status: 400 });

    const merchant = await resolvePayRef(supabase, body.ref);
    if (!merchant?.accountId) return NextResponse.json({ error: 'Pay identity not found.' }, { status: 404 });
    if (merchant.accountId === payerId) return NextResponse.json({ error: 'You cannot pay your own account.' }, { status: 400 });
    const { data: dest } = await supabase.from('accounts').select('agent_wallet_address').eq('id', merchant.accountId).maybeSingle();
    const to = dest?.agent_wallet_address;
    if (!to || !ethers.isAddress(to)) return NextResponse.json({ error: 'That account has no wallet yet.' }, { status: 400 });
    const note = cleanPayNote(body.note);

    // A swap is never a quick send: this route always asks for the PIN.
    const gate = await requireStepUp(supabase, payerId, String(body.pin || ''), 'pay');
    if (!gate.ok) {
      return NextResponse.json({ error: gate.error, code: gate.code, attemptsLeft: gate.attemptsLeft }, { status: gate.status });
    }

    const lock = await tryAccountTxLock(supabase, payerId, 'pay');
    if (!lock.ok) return NextResponse.json({ error: lock.error }, { status: 409 });

    try {
      const chain = getWebChain();
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
      let quote;
      try {
        quote = await quoteSwapPay(provider, asset, String(body.amount || ''));
      } catch (err) {
        return NextResponse.json({ error: quoteRefusal(err) }, { status: 400 });
      }
      // The page showed a ceiling; a price that moved past it is not paid silently.
      let ceiling: bigint | null = null;
      try {
        ceiling = body.maxEth ? ethers.parseEther(String(body.maxEth)) : null;
      } catch {
        ceiling = null;
      }
      if (ceiling !== null && quote.ethIn > ceiling) {
        return NextResponse.json({ error: 'The price moved. Review the new amount and try again.', code: 'REQUOTE' }, { status: 409 });
      }

      const { data: payer } = await supabase.from('accounts').select('agent_wallet_address').eq('id', payerId).maybeSingle();
      const viaGator = pointerIsGator(payerId, payer?.agent_wallet_address);
      const signer = deriveAgentWallet(payerId).connect(provider);
      const walletAddr = viaGator ? predictGatorAddress(payerId) : signer.address;
      const ethBal = await provider.getBalance(walletAddr);
      const gasBuf = viaGator ? await gatorGasReserveWei(provider, walletAddr) : gasBufferWei();
      if (ethBal < quote.ethIn + gasBuf) {
        return NextResponse.json({ error: fundingWallText({ kind: 'native', address: walletAddr }) }, { status: 400 });
      }
      // The ETH leaving counts against the daily limit, as any ETH payment does.
      const daily = await checkDailyNativeLimit(supabase, payerId, quote.ethIn);
      if (!daily.ok) return NextResponse.json({ error: daily.message }, { status: 400 });

      const asked = ethers.formatUnits(quote.amountOut, quote.decimals);
      const { data: logRow } = await supabase
        .from('transfers')
        .insert({
          account_id: payerId,
          phone: 'site',
          to_address: ethers.getAddress(to),
          amount_eth: asked,
          status: 'pending',
          chain_id: chain.chainId,
          kind: 'transfer',
          asset,
          token_address: ethers.getAddress(quote.token),
          amount_secondary: ethers.formatEther(quote.ethIn),
          asset_secondary: 'ETH',
          // Counted by daily_native_sent_eth, so paying with ETH spends the daily limit.
          eth_in: ethers.formatEther(quote.ethIn),
          counterparty_label: merchant.username ? `@${merchant.username}` : 'flizy pay',
          direction: 'out',
          note,
        })
        .select('id')
        .maybeSingle();
      const rowId = logRow?.id ?? null;

      let txHash: string;
      let receipt: ethers.TransactionReceipt | null;
      if (viaGator) {
        const sent = await executeSwapViaGator({
          accountId: payerId,
          provider,
          chainId: chain.chainId,
          amountIn: quote.ethIn,
          tokenIn: null,
          tokenOut: quote.token,
          amountOutMinWei: quote.amountOut,
          recipient: to,
          // Recorded before broadcast; with no row to record on, nothing is sent.
          onBroadcast: async (hash) => {
            if (!rowId) throw new Error('no transfer row');
            await markTransferSubmitted(supabase, rowId, hash);
          },
        }).catch(async (sendErr: unknown) => {
          if (rowId && !outcomeUnknown(sendErr)) {
            await supabase.from('transfers').update({ status: 'failed', error: 'not sent' }).eq('id', rowId);
          }
          throw sendErr;
        });
        txHash = sent.txHash;
        receipt = sent.receipt;
      } else {
        if (!rowId) return NextResponse.json({ error: 'Could not start the payment. Try again.' }, { status: 500 });
        const sent = await executeSwap({
          signer,
          amountIn: quote.ethIn,
          tokenIn: null,
          tokenOut: quote.token,
          amountOutMinWei: quote.amountOut,
          recipient: to,
        });
        txHash = sent.txHash;
        receipt = sent.receipt;
      }
      const ok = Boolean(receipt && receipt.status === 1);
      // What landed, read from the receipt: at least what was asked, by the swap's own minimum.
      const landed = ok && receipt ? receivedInReceipt(receipt, quote.token, to) : 0n;
      const amount = landed > 0n ? ethers.formatUnits(landed, quote.decimals) : asked;

      if (rowId) {
        await supabase
          .from('transfers')
          .update({ status: ok ? 'confirmed' : 'failed', tx_hash: txHash, amount_eth: amount, error: ok ? null : 'receipt status not successful' })
          .eq('id', rowId);
      }
      if (!ok) return NextResponse.json({ error: 'Payment failed on-chain.' }, { status: 502 });

      try {
        const { data: payerRow } = await supabase.from('accounts').select('username, display_name').eq('id', payerId).maybeSingle();
        await notifyAllChannels(
          merchant.accountId,
          formatPaymentReceived({ amount, asset, note, fromLabel: payerLabel(payerRow), walletUrl: `${siteOrigin()}/dashboard/wallet` })
        );
      } catch {
        console.warn(`[POST ${ROUTE}] payee notice was not queued`);
      }

      return NextResponse.json({ ok: true, txHash, explorerUrl: explorerTxUrl(chain, txHash), transferId: rowId, amount, unit: symbolLabel(asset) });
    } finally {
      await releaseAccountTxLock(supabase, payerId);
    }
  } catch (err) {
    const executorOutcome = gatorFailure(err);
    if (executorOutcome) return NextResponse.json(executorOutcome.body, { status: executorOutcome.status });
    return NextResponse.json(apiErrorBody(`POST ${ROUTE}`, err), { status: 500 });
  }
}
