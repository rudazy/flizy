import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../../lib/apiError';
import { deleteThesis, listedTokenKey } from '../../../../../../lib/tokenSocial';

const ROUTE = 'DELETE /api/tokens/[symbol]/theses/[id]';

/** The author or an admin removes a thesis. */
export async function DELETE(req: Request, { params }: { params: { symbol: string; id: string } }) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const key = listedTokenKey(params.symbol);
    if (!key) return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    await deleteThesis(accountId, key, params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 400 });
  }
}
