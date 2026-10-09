import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBody, apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { canEditTokenProfile, getTokenProfile, isWatched, listedTokenKey, updateTokenProfile } from '../../../../../lib/tokenSocial';

const GET_ROUTE = 'GET /api/tokens/[symbol]/profile';
const PATCH_ROUTE = 'PATCH /api/tokens/[symbol]/profile';

type Params = { params: { symbol: string } };

/** The token's profile, whether this account has it on its watchlist, and whether it may edit it. */
export async function GET(_req: Request, { params }: Params) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const key = listedTokenKey(params.symbol);
    if (!key) return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    const [profile, watched, canEdit] = await Promise.all([
      getTokenProfile(key),
      isWatched(accountId, key),
      canEditTokenProfile(accountId),
    ]);
    return NextResponse.json({ profile, watched, canEdit });
  } catch (err) {
    return NextResponse.json(apiErrorBody(GET_ROUTE, err), { status: 500 });
  }
}

/** Admins only. Fields left out are not changed. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const key = listedTokenKey(params.symbol);
    if (!key) return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const profile = await updateTokenProfile(accountId, key, {
      logo: body.logo === null || typeof body.logo === 'string' ? body.logo : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      links: Array.isArray(body.links) ? body.links : undefined,
      creatorUsername:
        body.creatorUsername === null || typeof body.creatorUsername === 'string' ? body.creatorUsername : undefined,
    });
    return NextResponse.json({ ok: true, profile });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(PATCH_ROUTE, err), { status: 400 });
  }
}
