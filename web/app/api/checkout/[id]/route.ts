/**
 * GET /api/checkout/{id}: the state of a checkout, for its page to follow. No
 * session: the payer is not a Flizy user. Only what the page already shows.
 *
 * POST /api/checkout/{id}: the page hands over the transaction the payer just
 * sent, so the payment is recorded without waiting for the VPS watcher. The
 * body is believed only as a pointer: the receipt decides (web/lib/checkout.ts).
 * Capped per caller per hour, like outside-wallet payments.
 */

import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError, ClientError } from '../../../../lib/apiError';
import { clientIpKey } from '../../../../lib/clientIp';
import { getWebChain } from '../../../../lib/dexServer';
import { TX_HASH_RE, takeExternalAttempt } from '../../../../lib/externalPay.ts';
import { checkoutPaymentsIn, loadCheckout, recordCheckoutPayments } from '../../../../lib/checkout.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_THIS = 'That transaction did not pay this checkout.';

function status(view: NonNullable<Awaited<ReturnType<typeof loadCheckout>>>) {
  return { state: view.state, received: view.received, overpaid: view.overpaid, expiresAt: view.expiresAt };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!UUID.test(String(id || ''))) return NextResponse.json({ error: 'Checkout not found.' }, { status: 404 });
    const view = await loadCheckout(getSupabase(), id);
    if (!view) return NextResponse.json({ error: 'Checkout not found.' }, { status: 404 });
    return NextResponse.json(status(view), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError('GET /api/checkout/[id]', err), { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const db = getSupabase();
    if (!(await takeExternalAttempt(db, clientIpKey(req.headers)))) {
      return NextResponse.json({ error: 'Too many checks from here. Try again in a while.' }, { status: 429 });
    }
    const { id } = await params;
    if (!UUID.test(String(id || ''))) return NextResponse.json({ error: 'Checkout not found.' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const txHash = String(body?.txHash || '');
    if (!TX_HASH_RE.test(txHash)) return NextResponse.json({ error: 'That is not a transaction hash.' }, { status: 400 });

    const view = await loadCheckout(db, id);
    if (!view) return NextResponse.json({ error: 'Checkout not found.' }, { status: 404 });

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    const receipt = await provider.getTransactionReceipt(txHash);
    // Not mined yet: the page asks again shortly.
    if (!receipt) return NextResponse.json({ pending: true }, { status: 202 });
    const payments = checkoutPaymentsIn(receipt, view);
    if (!payments.length) return NextResponse.json({ error: NOT_THIS }, { status: 400 });
    await recordCheckoutPayments(db, id, txHash, payments);
    const now = await loadCheckout(db, id);
    return NextResponse.json(now ? status(now) : {}, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError('POST /api/checkout/[id]', err), { status: err instanceof ClientError ? 400 : 500 });
  }
}
