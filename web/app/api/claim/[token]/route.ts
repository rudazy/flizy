import { NextResponse } from 'next/server';
import { getClaimByToken } from '../../../../lib/claims';

export async function GET(_req: Request, ctx: { params: { token: string } }) {
  try {
    const claim = await getClaimByToken(ctx.params.token);
    if (!claim) return NextResponse.json({ error: 'Claim not found' }, { status: 404 });
    return NextResponse.json({
      amount_eth: claim.amount_eth,
      status: claim.status,
      chain_id: claim.chain_id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Claim failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
