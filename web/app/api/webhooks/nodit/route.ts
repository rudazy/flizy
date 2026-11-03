/**
 * Nodit webhook for the listed pairs' Swap and Sync logs.
 *
 * A hint, never a source: the body only tells us which transactions to look
 * at. Each one is re-read from our own RPC (web/lib/pairEvents.ts,
 * indexTransactions), and only a successful transaction's logs from a listed
 * pair are written, keyed by tx hash and log index so a retry or a resend
 * lands once. The getLogs poller keeps the index complete without this route.
 *
 * Nodit signs each message: x-signature is the hex HMAC-SHA256 of the JSON
 * body under the webhook's signing key. The signature is checked before the
 * body is used for anything. NODIT_WEBHOOK_SIGNING_KEY is server only; with it
 * unset the route refuses every caller. Server to server, so there is no
 * browser Origin to check.
 */

import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { apiErrorBody } from '../../../../lib/apiError';
import { noditSignatureOk } from '../../../../lib/noditSignature.ts';
import { getSupabase } from '../../../../lib/supabase.ts';
import { getDexAddresses } from '../../../../lib/dexServer';
import { getWebChain } from '../../../../lib/webChain.ts';
import { listedPairs } from '../../../../lib/listedPairs.ts';
import { indexTransactions, txHashesIn } from '../../../../lib/pairEvents.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROUTE = 'POST /api/webhooks/nodit';

/** A webhook body larger than this is not one of ours. */
const MAX_BODY = 256 * 1024;

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return NextResponse.json({ error: 'Too large' }, { status: 413 });
    if (!noditSignatureOk(raw, req.headers.get('x-signature'), process.env.NODIT_WEBHOOK_SIGNING_KEY)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    }
    const txHashes = txHashesIn(body);
    if (!txHashes.length) return NextResponse.json({ ok: true, rows: 0 });

    const chain = getWebChain();
    const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    try {
      const rows = await indexTransactions({
        provider,
        db: getSupabase(),
        chainId: chain.chainId,
        pairs: listedPairs(getDexAddresses()),
        txHashes,
      });
      return NextResponse.json({ ok: true, rows });
    } finally {
      try {
        provider.destroy();
      } catch {
        // The answer is already decided.
      }
    }
  } catch (err) {
    // A 500 makes Nodit retry once; the poller covers anything still missed.
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
