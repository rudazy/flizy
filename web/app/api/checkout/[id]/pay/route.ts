/**
 * POST /api/checkout/{id}/pay: pay a Flizy Pay API checkout from the signed-in
 * account's Flizy wallet.
 *
 * The same controls as paying any Flizy account (/api/pay/execute): the PIN
 * whenever the tier asks for it (decided here from what will be sent), the
 * account lock, the Savings fence, gas, the daily ETH limit under the lock, and
 * a secured account's daily passkey limit (web/lib/custody/allowanceLeft.ts).
 * The amount is what the checkout still lacks, never a number from the
 * browser, and it goes through FlizyPaymentReceiver with the checkout's invoice
 * id, straight to the platform's wallet, so it settles exactly as a payment
 * from any other wallet does: the receipt is read and recorded once by
 * api_record_payment (web/lib/checkout.ts). A token payment approves exactly
 * that amount for the receiver, then pays; the receiver only ever pulls from
 * the wallet that calls it, so the approval is of no use to anyone else.
 */

import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { requireApproval } from '../../../../../lib/stepUp.ts';
import { sendTier } from '../../../../../lib/tiers.ts';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { deriveAgentWallet, getWebChain, explorerTxUrl } from '../../../../../lib/dexServer';
import { apiErrorBody } from '../../../../../lib/apiError';
import { tryAccountTxLock, releaseAccountTxLock } from '../../../../../lib/accountTxLock.ts';
import { executeApprovalCall, executeGatorCall, pointerIsGator, gatorGasReserveWei, outcomeUnknown } from '../../../../../lib/gatorExecute.ts';
import { predictGatorAddress } from '../../../../../lib/gatorAccount.ts';
import { fundingWallText } from '../../../../../lib/fundingWall.ts';
import { checkDailyNativeLimit } from '../../../../../lib/dailyLimits.ts';
import { gatorFailure, markTransferSubmitted } from '../../../../../lib/gatorOutcome.ts';
import { assertSpendable, resolveReserveAsset } from '../../../../../lib/reserveStore';
import { PAYMENT_RECEIVER, PAYMENT_RECEIVER_ABI } from '../../../../../lib/paymentReceiver.ts';
import { PAYOUT_ASSETS, plainAmount } from '../../../../../lib/apiPayouts.ts';
import { checkoutPaymentsIn, loadCheckout, recordCheckoutPayments } from '../../../../../lib/checkout.ts';
import { passkeyLimitRefusal } from '../../../../../lib/custody/allowanceLeft.ts';
import { symbolLabel } from '../../../../../lib/listedTokens';

const ROUTE = 'POST /api/checkout/[id]/pay';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIVER = new ethers.Interface(PAYMENT_RECEIVER_ABI as unknown as ethers.InterfaceAbi);
const ERC20 = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

function gasBufferWei(): bigint {
  try {
    return ethers.parseEther(String(process.env.GAS_BUFFER_ETH || '0.0001'));
  } catch {
    return ethers.parseEther('0.0001');
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const payerId = await getAccountIdFromCookie();
    if (!payerId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const { id } = await params;
    if (!UUID.test(String(id || ''))) return NextResponse.json({ error: 'Checkout not found.' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const supabase = getSupabase();

    const view = await loadCheckout(supabase, id);
    if (!view) return NextResponse.json({ error: 'Checkout not found.' }, { status: 404 });
    if (view.state !== 'accepted' || Date.parse(view.expiresAt) <= Date.now() || !view.platformEnabled) {
      return NextResponse.json({ error: 'This checkout is no longer open.' }, { status: 409 });
    }
    if (view.platformAccountId === payerId) return NextResponse.json({ error: 'You cannot pay your own checkout.' }, { status: 400 });
    let due = view.amountUnits - view.receivedUnits;
    if (due <= 0n) return NextResponse.json({ error: 'This checkout is already paid.' }, { status: 409 });
    const native = view.asset === 'ETH';
    const decimals = PAYOUT_ASSETS[view.asset].decimals;

    const tier = await sendTier(supabase, payerId, view.payee, native, native ? due : 0n);
    const gate = await requireApproval(supabase, payerId, String(body.pin || ''), 'pay', tier);
    if (!gate.ok) return NextResponse.json({ error: gate.error, code: gate.code, attemptsLeft: gate.attemptsLeft }, { status: gate.status });

    const lock = await tryAccountTxLock(supabase, payerId, 'pay');
    if (!lock.ok) return NextResponse.json({ error: lock.error }, { status: 409 });
    try {
      // Read again under the lock: a payment that landed since (a double click,
      // or another payer) leaves less to pay, or nothing. Never more, so the
      // tier worked out above still covers it.
      const fresh = await loadCheckout(supabase, id);
      if (!fresh || fresh.state !== 'accepted' || Date.parse(fresh.expiresAt) <= Date.now() || !fresh.platformEnabled) {
        return NextResponse.json({ error: 'This checkout is no longer open.' }, { status: 409 });
      }
      due = fresh.amountUnits - fresh.receivedUnits;
      if (due <= 0n) return NextResponse.json({ error: 'This checkout is already paid.' }, { status: 409 });
      const dueHuman = plainAmount(due, decimals);
      const chain = getWebChain();
      const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
      const { data: payer } = await supabase.from('accounts').select('agent_wallet_address').eq('id', payerId).maybeSingle();
      const viaGator = pointerIsGator(payerId, payer?.agent_wallet_address);
      const signer = deriveAgentWallet(payerId).connect(provider);
      const walletAddr = viaGator ? predictGatorAddress(payerId) : signer.address;
      const ethBal = await provider.getBalance(walletAddr);
      const gasBuf = viaGator ? await gatorGasReserveWei(provider, walletAddr) : gasBufferWei();

      if (native) {
        const fence = await assertSpendable(supabase, payerId, { asset: 'ETH', holding: ethBal, amount: due, gas: gasBuf, decimals: 18, label: 'ETH' });
        if (!fence.ok) return NextResponse.json({ error: fence.message }, { status: 400 });
        if (ethBal < due + gasBuf) return NextResponse.json({ error: fundingWallText({ kind: 'native', address: walletAddr }) }, { status: 400 });
        const daily = await checkDailyNativeLimit(supabase, payerId, due);
        if (!daily.ok) return NextResponse.json({ error: daily.message }, { status: 400 });
      } else {
        const info = resolveReserveAsset(view.asset);
        if (!info || !view.token) return NextResponse.json({ error: 'Could not read Savings. Nothing was sent.' }, { status: 400 });
        const gasFence = await assertSpendable(supabase, payerId, { asset: 'ETH', holding: ethBal, amount: 0n, gas: gasBuf, decimals: 18, label: 'ETH' });
        if (!gasFence.ok) return NextResponse.json({ error: gasFence.message }, { status: 400 });
        if (ethBal < gasBuf) return NextResponse.json({ error: fundingWallText({ kind: 'gas', address: walletAddr }) }, { status: 400 });
        const tokBal = BigInt(await provider.call({ to: view.token, data: ERC20.encodeFunctionData('balanceOf', [walletAddr]) }));
        const fence = await assertSpendable(supabase, payerId, { asset: info.asset, holding: tokBal, amount: due, gas: 0n, decimals: info.decimals, label: info.label });
        if (!fence.ok) return NextResponse.json({ error: fence.message }, { status: 400 });
        if (tokBal < due) return NextResponse.json({ error: fundingWallText({ kind: 'token', asset: view.asset, address: walletAddr }) }, { status: 400 });
      }
      if (viaGator) {
        const capped = await passkeyLimitRefusal(supabase, provider, {
          route: ROUTE,
          accountId: payerId,
          wallet: walletAddr,
          symbol: view.asset,
          label: symbolLabel(view.asset),
          amount: due,
          decimals,
          next: () => 'Pay it from another wallet on this page, or with Flizy once your limit resets.',
        });
        if (capped) return NextResponse.json({ error: capped }, { status: 400 });
      }

      const { data: logRow } = await supabase
        .from('transfers')
        .insert({
          account_id: payerId,
          phone: 'site',
          to_address: view.payee,
          amount_eth: dueHuman,
          status: 'pending',
          chain_id: chain.chainId,
          kind: 'transfer',
          asset: view.asset,
          token_address: view.token,
          counterparty_label: `${view.platformName} (Flizy partner)`,
          direction: 'out',
          note: 'Checkout',
        })
        .select('id')
        .maybeSingle();
      const rowId = logRow?.id ?? null;

      // A token first gets an exact approval for the receiver (an approval moves
      // no value and records nothing); then one call into the receiver pays.
      const markFailed = async () => {
        if (rowId) await supabase.from('transfers').update({ status: 'failed', error: 'not sent' }).eq('id', rowId);
      };
      if (!native && view.token) {
        const allowed = BigInt(await provider.call({ to: view.token, data: ERC20.encodeFunctionData('allowance', [walletAddr, PAYMENT_RECEIVER]) }));
        if (allowed < due) {
          const approveData = ERC20.encodeFunctionData('approve', [PAYMENT_RECEIVER, due]);
          try {
            if (viaGator) {
              await executeApprovalCall({ accountId: payerId, provider, chainId: chain.chainId, target: view.token, value: 0n, data: approveData });
            } else {
              await (await signer.sendTransaction({ to: view.token, data: approveData })).wait(1);
            }
          } catch (approveErr) {
            // The payment itself was never sent.
            await markFailed();
            throw approveErr;
          }
        }
      }
      const payData = native
        ? RECEIVER.encodeFunctionData('payNative', [view.invoiceId, view.payee])
        : RECEIVER.encodeFunctionData('payToken', [view.invoiceId, view.token, view.payee, due]);
      const payValue = native ? due : 0n;

      let txHash = '';
      let receipt: ethers.TransactionReceipt | null = null;
      if (viaGator) {
        const sent = await executeGatorCall({
          // Recorded before broadcast; with no row to record on, nothing is sent.
          onBroadcast: async (hash) => {
            if (!rowId) throw new Error('no transfer row');
            await markTransferSubmitted(supabase, rowId, hash);
          },
          accountId: payerId,
          provider,
          chainId: chain.chainId,
          target: PAYMENT_RECEIVER,
          value: payValue,
          data: payData,
        }).catch(async (sendErr: unknown) => {
          // Unknown outcome: the row stays 'submitted' for the reconciler.
          if (rowId && !outcomeUnknown(sendErr)) await markFailed();
          throw sendErr;
        });
        txHash = sent.txHash;
        receipt = sent.receipt;
      } else {
        const tx = await signer.sendTransaction({ to: PAYMENT_RECEIVER, value: payValue, data: payData });
        txHash = tx.hash;
        receipt = await tx.wait(1);
      }
      const ok = Boolean(receipt && receipt.status === 1);
      if (rowId) {
        await supabase.from('transfers').update({ status: ok ? 'confirmed' : 'failed', tx_hash: txHash || null, error: ok ? null : 'receipt status not successful' }).eq('id', rowId);
      }
      if (!ok || !receipt) return NextResponse.json({ error: 'Payment failed on-chain.' }, { status: 502 });

      // Settled the same way as any wallet's payment: from the receipt, once.
      // The money has moved: if recording fails here, the payment is still
      // reported as sent, and the VPS watcher settles it from the chain.
      try {
        await recordCheckoutPayments(supabase, id, txHash, checkoutPaymentsIn(receipt, view));
      } catch {
        console.warn(`[${ROUTE}] recorded later by the watcher`);
      }
      const now = await loadCheckout(supabase, id).catch(() => null);
      return NextResponse.json({
        ok: true,
        state: now?.state ?? view.state,
        received: now?.received ?? view.received,
        txHash,
        explorerUrl: explorerTxUrl(chain, txHash),
      });
    } finally {
      await releaseAccountTxLock(supabase, payerId);
    }
  } catch (err) {
    const executorOutcome = gatorFailure(err);
    if (executorOutcome) return NextResponse.json(executorOutcome.body, { status: executorOutcome.status });
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
