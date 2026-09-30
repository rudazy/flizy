import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { ClientError, apiErrorBodyAllowingClientError } from '../../../../lib/apiError';
import { addAccountToken, removeAccountToken } from '../../../../lib/accountTokens';

const POST_ROUTE = 'POST /api/wallet/tokens';
const DELETE_ROUTE = 'DELETE /api/wallet/tokens';

function fail(route: string, err: unknown) {
  const status = err instanceof ClientError ? 400 : 500;
  return NextResponse.json(apiErrorBodyAllowingClientError(route, err), { status });
}

function addressFrom(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const raw = (body as { address?: unknown }).address;
  return typeof raw === 'string' ? raw : '';
}

/** Remember a contract so a deposit of that token shows on the wallet. */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => null);
    const token = await addAccountToken(accountId, addressFrom(body));
    return NextResponse.json({ token });
  } catch (err) {
    return fail(POST_ROUTE, err);
  }
}

/** Drop a contract this account added. FLZ is not one of those rows. */
export async function DELETE(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => null);
    const token = await removeAccountToken(accountId, addressFrom(body));
    return NextResponse.json({ ok: true, token });
  } catch (err) {
    return fail(DELETE_ROUTE, err);
  }
}
