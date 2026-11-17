/**
 * POST /api/claim/cancel
 * Body: { claimId }
 *
 * The sender cancels a pending claim from History and its money goes back to
 * their Flizy wallet. Same owner check and race rules as chat's cancel claims:
 * only the account that sent it, only while it is pending.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { executeWebClaimRefund } from '../../../../lib/claimPayout';
import { apiErrorBody } from '../../../../lib/apiError';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';

const ROUTE = 'POST /api/claim/cancel';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Log in to cancel a claim.' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const claimId = String(body.claimId || '').trim();
    if (!UUID.test(claimId)) {
      return NextResponse.json({ error: 'Claim not found.' }, { status: 404 });
    }

    const result = await executeWebClaimRefund({ claimId, accountId });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, refundTxHash: result.refundTxHash, explorerUrl: result.explorerUrl });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
