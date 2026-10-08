import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../lib/apiError';
import { claimFaucet } from '../../../../lib/faucet';

const ROUTE = 'POST /api/faucet/claim';

/** Room for the signer lock wait and one confirmation on GIWA, which closes blocks in seconds. */
export const maxDuration = 60;

/**
 * Claim test ETH into the signed-in account's own wallet. The request carries
 * nothing: amount, destination and cooldown are all decided on the server.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const receipt = await claimFaucet(accountId);
    return NextResponse.json({ ok: true, ...receipt });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
