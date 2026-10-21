import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getSupabase } from '../../../../lib/supabase';
import { resolvePayRef } from '../../../../lib/payCode.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../lib/apiError';
import { clientIpKey } from '../../../../lib/clientIp';
import { getDexAddresses, getWebChain } from '../../../../lib/dexServer';
import {
  EXTERNAL_NOTHING_FOUND,
  TX_HASH_RE,
  paymentsInReceipt,
  recordExternalPayments,
  takeExternalAttempt,
} from '../../../../lib/externalPay.ts';
import { INVOICE_NONCE_RE, PAYMENT_RECEIVER } from '../../../../lib/paymentReceiver.ts';
import { invoiceIdFor } from '../../../../lib/invoiceId.ts';
import { cleanPayNote } from '../../../../lib/payLink.ts';
import { notifyAllChannels } from '../../../../lib/notifyChannels';
import { formatPaymentReceived } from '../../../../lib/payNotice.ts';
import { siteOrigin } from '../../../../lib/siteOrigin';

const ROUTE = 'POST /api/pay/external';

const OUTSIDE_PAY_OFF = 'This account takes payments from Flizy accounts only.';

/**
 * A wallet outside Flizy paid this account; check it on chain and record it.
 *
 * No session: the payer is not a Flizy user. Nothing in the body is believed
 * except as a pointer: the payment is read from the transaction receipt and
 * must come from FlizyPaymentReceiver to this account's wallet
 * (web/lib/externalPay.ts). The note is kept only when it hashes, with the
 * nonce, to the invoice id the payer put on chain. Capped per caller per hour.
 *
 * GET with ?ref= returns the wallet to pay, which a browser wallet needs, and
 * the FLZ contract, which is not in the listed tokens the page carries. Only
 * for an account that turned on accounts.accept_outside_pay: the address ties
 * the name to the wallet, which nobody gets without the owner's say.
 */
export async function GET(req: Request) {
  try {
    const ref = new URL(req.url).searchParams.get('ref') || '';
    const merchant = await resolvePayRef(getSupabase(), ref);
    if (!merchant?.accountId) return NextResponse.json({ error: 'Pay identity not found.' }, { status: 404 });
    const { data } = await getSupabase()
      .from('accounts')
      .select('agent_wallet_address, accept_outside_pay')
      .eq('id', merchant.accountId)
      .maybeSingle();
    if (data?.accept_outside_pay !== true) {
      return NextResponse.json({ error: OUTSIDE_PAY_OFF }, { status: 403 });
    }
    const to = data?.agent_wallet_address;
    if (!to || !ethers.isAddress(to)) return NextResponse.json({ error: 'That account has no wallet yet.' }, { status: 400 });
    return NextResponse.json({
      payee: ethers.getAddress(to),
      receiver: PAYMENT_RECEIVER,
      chainId: getWebChain().chainId,
      flz: getDexAddresses().flz,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError('GET /api/pay/external', err), { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const supabase = getSupabase();
    if (!(await takeExternalAttempt(supabase, clientIpKey(req.headers)))) {
      return NextResponse.json({ error: 'Too many checks from here. Try again in a while.' }, { status: 429 });
    }

    const body = await req.json().catch(() => ({}));
    const txHash = String(body?.txHash || '');
    if (!TX_HASH_RE.test(txHash)) return NextResponse.json({ error: 'That is not a transaction hash.' }, { status: 400 });

    const merchant = await resolvePayRef(supabase, body?.ref);
    if (!merchant?.accountId) return NextResponse.json({ error: 'Pay identity not found.' }, { status: 404 });
    const { data: dest } = await supabase
      .from('accounts')
      .select('agent_wallet_address')
      .eq('id', merchant.accountId)
      .maybeSingle();
    const payee = dest?.agent_wallet_address;
    if (!payee || !ethers.isAddress(payee)) {
      return NextResponse.json({ error: 'That account has no wallet yet.' }, { status: 400 });
    }

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    const receipt = await provider.getTransactionReceipt(txHash);
    // Not mined yet: the page asks again shortly.
    if (!receipt) return NextResponse.json({ pending: true }, { status: 202 });

    const payments = paymentsInReceipt(receipt, payee);
    if (!payments.length) return NextResponse.json({ error: EXTERNAL_NOTHING_FOUND }, { status: 400 });

    const note = cleanPayNote(body?.note);
    const nonce = String(body?.nonce || '');
    const noteHolds = Boolean(note) && INVOICE_NONCE_RE.test(nonce) && payments.every((p) => p.invoiceId === invoiceIdFor(note, nonce));
    const recorded = await recordExternalPayments(supabase, {
      txHash,
      payeeAccountId: merchant.accountId,
      payments,
      note: noteHolds ? note : null,
    });

    // The payee hears about each payment once: a second confirm records nothing.
    // Dust is recorded but not announced, so nobody can spam a payee's chats
    // with a stream of near-free payments.
    for (const pay of recorded) {
      if (Number(pay.amount) < (pay.asset === 'ETH' ? 0.0001 : 0.01)) continue;
      try {
        await notifyAllChannels(
          merchant.accountId,
          formatPaymentReceived({
            amount: pay.amount,
            asset: pay.asset,
            note: noteHolds ? note : null,
            fromLabel: `an outside wallet (${pay.payer.slice(0, 6)}…${pay.payer.slice(-4)})`,
            walletUrl: `${siteOrigin()}/dashboard/wallet`,
          })
        );
      } catch {
        console.warn(`[${ROUTE}] payee notice was not queued`);
      }
    }

    const first = payments[0];
    return NextResponse.json({
      ok: true,
      amount: first.amount,
      asset: first.asset,
      explorerUrl: `${chain.explorerBaseUrl}/tx/${txHash}`,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
