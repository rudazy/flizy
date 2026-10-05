import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { rejectIfCrossOrigin } from '../../../lib/requestOrigin.ts';
import { ClientError, apiErrorBodyAllowingClientError } from '../../../lib/apiError';
import { isCopyKind, readCopySetup, saveCopySetup } from '../../../lib/copySetup';

const GET_ROUTE = 'GET /api/copy';
const PUT_ROUTE = 'PUT /api/copy';

function fail(route: string, err: unknown) {
  const status = err instanceof ClientError ? 400 : 500;
  return NextResponse.json(apiErrorBodyAllowingClientError(route, err), { status });
}

/** The saved copy setup. Reading it does not follow a wallet or send a trade. */
export async function GET(req: Request) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const kind = new URL(req.url).searchParams.get('kind') || '';
    if (!isCopyKind(kind)) {
      return NextResponse.json({ error: 'Choose trade or mint.' }, { status: 400 });
    }
    const setup = await readCopySetup(accountId, kind);
    return NextResponse.json({ setup });
  } catch (err) {
    return fail(GET_ROUTE, err);
  }
}

/** Replace this account's wallets and limits for one kind. Saving does not send a trade. */
export async function PUT(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => null);
    const setup = await saveCopySetup(accountId, body);
    return NextResponse.json({ ok: true, setup });
  } catch (err) {
    return fail(PUT_ROUTE, err);
  }
}
