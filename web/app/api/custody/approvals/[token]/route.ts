/**
 * /api/custody/approvals/{token}: one chat payment over the daily cap,
 * waiting for the account's passkey (web/lib/custody/approvals.ts).
 *
 *   GET                              what the approval page shows, from the stored row
 *   POST { action: 'begin' }         the one-off permission's digest, as the passkey challenge
 *   POST { action: 'finish', ... }   the passkey's answer; checked by the wallet itself
 *   POST { action: 'cancel' }        closes it before it is sent
 *
 * Signed in, pilot account only, and only the account the payment belongs to:
 * any other session gets the same answer as a link that never existed.
 */

import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../../lib/cookies';
import { getSupabase } from '../../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../../lib/requestOrigin.ts';
import { apiErrorBodyAllowingClientError, ClientError } from '../../../../../lib/apiError';
import { getWebChain } from '../../../../../lib/dexServer';
import { beginApproval, cancelApproval, finishApproval, viewApproval, type ApprovalDeps } from '../../../../../lib/custody/approvals.ts';

const ROUTE = '/api/custody/approvals/[token]';

export const dynamic = 'force-dynamic';

type Ctx = { params: { token: string } };

function deps(): ApprovalDeps {
  const chain = getWebChain();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
  return { call: (to, data) => provider.call({ to, data }) };
}

function failure(err: unknown) {
  return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: err instanceof ClientError ? 400 : 500 });
}

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const view = await viewApproval(getSupabase(), accountId, params.token, deps());
    return NextResponse.json(view, { headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(req: Request, { params }: Ctx) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const supabase = getSupabase();

    if (body?.action === 'begin') {
      return NextResponse.json(await beginApproval(supabase, accountId, params.token, deps()), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (body?.action === 'finish') {
      const answer = {
        credentialId: String(body.credentialId || ''),
        authenticatorData: String(body.authenticatorData || ''),
        clientDataJSON: String(body.clientDataJSON || ''),
        signature: String(body.signature || ''),
      };
      return NextResponse.json(await finishApproval(supabase, accountId, params.token, answer, req.headers.get('origin') || '', deps()));
    }
    if (body?.action === 'cancel') {
      return NextResponse.json(await cancelApproval(supabase, accountId, params.token, deps()));
    }
    return NextResponse.json({ error: 'Choose begin, finish or cancel.' }, { status: 400 });
  } catch (err) {
    return failure(err);
  }
}
