import { NextResponse } from 'next/server';
import { getClaimByToken } from '../../../../lib/claims';
import { publicRecipientLabel } from '../../../../lib/claimRecipient';
import { apiErrorBody } from '../../../../lib/apiError';

const ROUTE = 'GET /api/claim/[token]';

// params is a promise since Next 15.
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const claim = await getClaimByToken(token);
    if (!claim) return NextResponse.json({ error: 'Claim not found' }, { status: 404 });
    const isPlatform = Boolean(claim.to_channel);
    return NextResponse.json({
      amount_eth: claim.amount_eth,
      status: claim.status,
      chain_id: claim.chain_id,
      // Never the full phone, and never the raw platform id. A phone is masked
      // to the last 4; a platform claim shows the handle the sender typed, which
      // is what lets the recipient recognize the claim as theirs.
      recipient: publicRecipientLabel(claim),
      recipient_kind: isPlatform ? 'platform' : 'phone',
      // Phone holds: show on web, payout only in WA/TG after number is proven there.
      can_claim_on_web: isPlatform,
      // Kept so an already-deployed page keeps rendering while it catches up.
      to_wa_hint: claim.to_wa_hint
        ? `...${String(claim.to_wa_hint).slice(-4)}`
        : undefined,
    });
  } catch (err) {
    // This route is reachable without logging in, from a link that gets pasted
    // around, so it is the cheapest place to probe. The token is the credential
    // for that claim and never goes in the log.
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
