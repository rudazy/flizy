import { NextResponse } from 'next/server';
import { createLinkCode } from '../../../../lib/identity';
import { getAccountIdFromCookie } from '../../../../lib/cookies';

export async function POST() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }
    const link = await createLinkCode(accountId);
    return NextResponse.json(link);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Link create failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
