/**
 * The signed-in account's own follower counts and profile switches.
 * Not a follow of someone else, and not a payment.
 */

import { NextResponse } from 'next/server';
import { apiErrorBody, ClientError } from '../../../lib/apiError';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { ownSocial, setProfileVisibility } from '../../../lib/followStore.ts';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';

const ROUTE = 'GET|PATCH /api/follow';

function answered(err: unknown) {
  if (err instanceof ClientError) {
    // Deliberate: ClientError messages are author-written product copy.
    return NextResponse.json({ error: err.message }, { status: 503 });
  }
  return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
}

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    return NextResponse.json(await ownSocial(accountId));
  } catch (err) {
    return answered(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const keys = [
      'profilePublic',
      'showSocial',
      'showStats',
      'showActivity',
      'showWallet',
      'showPortfolio',
      'showUsername',
    ] as const;
    const chosen = keys.map((key) => body?.[key]);
    if (!chosen.some((value) => typeof value === 'boolean')) {
      return NextResponse.json({ error: 'Choose on or off.' }, { status: 400 });
    }
    if (chosen.some((value) => value !== undefined && typeof value !== 'boolean')) {
      return NextResponse.json({ error: 'Choose on or off.' }, { status: 400 });
    }
    const saved = await setProfileVisibility(accountId, {
      profilePublic: typeof body?.profilePublic === 'boolean' ? body.profilePublic : undefined,
      showSocial: typeof body?.showSocial === 'boolean' ? body.showSocial : undefined,
      showStats: typeof body?.showStats === 'boolean' ? body.showStats : undefined,
      showActivity: typeof body?.showActivity === 'boolean' ? body.showActivity : undefined,
      showWallet: typeof body?.showWallet === 'boolean' ? body.showWallet : undefined,
      showPortfolio: typeof body?.showPortfolio === 'boolean' ? body.showPortfolio : undefined,
      showUsername: typeof body?.showUsername === 'boolean' ? body.showUsername : undefined,
    });
    return NextResponse.json(saved);
  } catch (err) {
    return answered(err);
  }
}
