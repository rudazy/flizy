import { NextResponse } from 'next/server';
import { getClaimByToken } from '../../../../lib/claims';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'GET /api/claim/[token]';

export async function GET(_req: Request, ctx: { params: { token: string } }) {
  try {
    const claim = await getClaimByToken(ctx.params.token);
    if (!claim) return NextResponse.json({ error: 'Claim not found' }, { status: 404 });
    return NextResponse.json({
      amount_eth: claim.amount_eth,
      status: claim.status,
      chain_id: claim.chain_id,
      // Do not expose full phone; optional masked later
      to_wa_hint: claim.to_wa_hint
        ? `…${String(claim.to_wa_hint).slice(-4)}`
        : undefined,
    });
  } catch (err) {
    // This route is reachable without logging in, from a link that gets pasted
    // around, so it is the cheapest place to probe. The token is the credential
    // for that claim and never goes in the log.
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
