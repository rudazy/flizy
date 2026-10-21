import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../lib/apiError';
import { claimFaucet, normalizeFaucetAsset } from '../../../../lib/faucet';

const ROUTE = 'POST /api/faucet/claim';

/** Room for the signer lock wait and one confirmation on GIWA, which closes blocks in seconds. */
export const maxDuration = 60;

/**
 * Claim test ETH, or test USD with ?asset=tusd, into the signed-in account's
 * own wallet. The body is never read: amount, destination and cooldown are all
 * decided on the server, and the query only picks one of two fixed assets.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const asset = normalizeFaucetAsset(new URL(req.url).searchParams.get('asset'));
    const receipt = await claimFaucet(accountId, { asset });
    return NextResponse.json({ ok: true, ...receipt });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
