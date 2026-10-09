import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBody, apiErrorBodyAllowingClientError } from '../../../../../lib/apiError';
import { listTheses, listedTokenKey, postThesis } from '../../../../../lib/tokenSocial';

const GET_ROUTE = 'GET /api/tokens/[symbol]/theses';
const POST_ROUTE = 'POST /api/tokens/[symbol]/theses';

type Params = { params: { symbol: string } };

export async function GET(req: Request, { params }: Params) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const key = listedTokenKey(params.symbol);
    if (!key) return NextResponse.json({ error: 'This token is not listed.' }, { status: 404 });
    const limit = Number(new URL(req.url).searchParams.get('limit') || 20);
    return NextResponse.json(await listTheses(key, accountId, { limit }));
  } catch (err) {
    return NextResponse.json(apiErrorBody(GET_ROUTE, err), { status: 500 });
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
    const thesis = await postThesis(accountId, key, { sentiment: String(body.sentiment || ''), body: String(body.body || '') });
    return NextResponse.json({ ok: true, thesis });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(POST_ROUTE, err), { status: 400 });
  }
}
