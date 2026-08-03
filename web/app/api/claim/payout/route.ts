/**
 * POST /api/claim/payout
 * Body: { claimId } or { token }
 *
 * Logged-in user receives escrow funds when their linked phone/platform
 * matches the claim. Same race rules as chat flizy claim.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getClaimByToken } from '../../../../lib/claims';
import {
  executeWebClaimPayout,
  getClaimById,
} from '../../../../lib/claimPayout';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'POST /api/claim/payout';

export async function POST(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Log in to claim funds.' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    let claimId = String(body.claimId || '').trim();
    const token = String(body.token || '').trim();

    if (!claimId && token) {
      const claim = await getClaimByToken(token);
      if (!claim) {
        return NextResponse.json({ error: 'Claim not found.' }, { status: 404 });
      }
      claimId = String(claim.id);
    }

    if (!claimId) {
      return NextResponse.json({ error: 'claimId or token is required.' }, { status: 400 });
    }

    // Cheap existence check for clearer 404 before chain work
    const existing = await getClaimById(claimId);
    if (!existing) {
      return NextResponse.json({ error: 'Claim not found.' }, { status: 404 });
    }

    const result = await executeWebClaimPayout({ claimId, accountId });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status || 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      amount_eth: result.claim.amount_eth,
      status: result.claim.status,
      claimTxHash: result.claimTxHash,
      explorerUrl: result.explorerUrl,
    });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
