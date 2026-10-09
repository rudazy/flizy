import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError } from '../../../../../../../lib/apiError';
import { listComments, listedTokenKey, postComment } from '../../../../../../../lib/tokenSocial';

const GET_ROUTE = 'GET /api/tokens/[symbol]/theses/[id]/comments';
const POST_ROUTE = 'POST /api/tokens/[symbol]/theses/[id]/comments';

type Params = { params: { symbol: string; id: string } };

export async function GET(_req: Request, { params }: Params) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const key = listedTokenKey(params.symbol);
    if (!key) return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    return NextResponse.json({ comments: await listComments(key, params.id, accountId) });
  } catch (err) {
    // A missing thesis is a client error here, not a server fault.
    return NextResponse.json(apiErrorBodyAllowingClientError(GET_ROUTE, err), { status: 400 });
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const key = listedTokenKey(params.symbol);
    if (!key) return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ ok: true, comment: await postComment(accountId, key, params.id, String(body.body || '')) });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(POST_ROUTE, err), { status: 400 });
  }
}
