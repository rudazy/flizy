/**
 * Deactivate or delete the signed-in account.
 *
 * Deactivate sets a timestamp and ends every web session. The next successful
 * sign-in with the account password clears it.
 *
 * Delete asks for that same password, then sets deleted_at. Sign-in cannot
 * clear it. The account row stays: the wallet pointer and chain history are
 * not dropped, and a wallet that still holds ETH is refused.
 */

import { NextResponse } from 'next/server';
import { clearAccountCookie, getAccountIdFromCookie, revokeAllSessions } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { apiErrorBody, apiErrorBodyAllowingClientError, ClientError } from '../../../../lib/apiError';
import { closureOf, isMissingClosureColumn } from '../../../../lib/accountClosure.ts';

const ROUTE = 'POST /api/account/closure';

function holdsInternalBalance(value: unknown): boolean {
  if (value == null || value === '') return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('balance read timed out')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function nativeBalanceState(address: string): Promise<'empty' | 'holds' | 'unknown'> {
  const { ethers } = await import('ethers');
  if (!address || !ethers.isAddress(address)) return 'empty';
  let provider: { destroy: () => void } | null = null;
  try {
    // Same RPC order as web/lib/dexServer.ts. A check against a different
    // endpoint can report an empty wallet that still holds ETH.
    const rpc = process.env.GIWA_RPC || process.env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io';
    const chainId = Number(process.env.GIWA_CHAIN_ID || 91342);
    if (!Number.isInteger(chainId) || chainId <= 0) return 'unknown';
    const next = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    provider = next;
    const bal = await withDeadline(next.getBalance(ethers.getAddress(address)), 8000);
    return bal > 0n ? 'holds' : 'empty';
  } catch {
    return 'unknown';
  } finally {
    provider?.destroy();
  }
}

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action === 'delete' ? 'delete' : body.action === 'deactivate' ? 'deactivate' : '';
    if (!action) {
      return NextResponse.json({ error: 'Choose deactivate or delete' }, { status: 400 });
    }

    const supabase = getSupabase();
    const { data: account, error: readError } = await supabase
      .from('accounts')
      .select('id, deleted_at, deactivated_at, balance_eth, agent_wallet_address')
      .eq('id', accountId)
      .maybeSingle();

    if (readError && isMissingClosureColumn(readError)) {
      throw new ClientError('Account closure is not available yet.');
    }
    if (readError || !account) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    if (closureOf(account) === 'deleted') {
      return NextResponse.json({ error: 'This account was already deleted.' }, { status: 409 });
    }

    if (action === 'delete') {
      const password = String(body.password || '').slice(0, 200);
      const gate = await requirePassword(supabase, accountId, password, 'delete this account');
      if (!gate.ok) {
        return NextResponse.json(
          { error: gate.error, ...(gate.code ? { code: gate.code } : {}) },
          { status: gate.status }
        );
      }
      if (holdsInternalBalance(account.balance_eth)) {
        return NextResponse.json(
          { error: 'This account still has a balance. Move it out, or deactivate.' },
          { status: 409 }
        );
      }
      const chain = await nativeBalanceState(String(account.agent_wallet_address || ''));
      if (chain === 'unknown') {
        return NextResponse.json(
          { error: 'Could not check the wallet. Nothing was deleted.' },
          { status: 503 }
        );
      }
      if (chain === 'holds') {
        return NextResponse.json(
          { error: 'The Flizy wallet still holds ETH. Move it out, or deactivate.' },
          { status: 409 }
        );
      }

      const now = new Date().toISOString();
      // The filter is the check that counts. A credit that lands after the
      // read above must not be deleted out from under itself.
      const { data: closed, error: writeError } = await supabase
        .from('accounts')
        .update({ deleted_at: now })
        .eq('id', accountId)
        .is('deleted_at', null)
        .lte('balance_eth', 0)
        .select('id')
        .maybeSingle();
      if (writeError) {
        if (isMissingClosureColumn(writeError)) {
          throw new ClientError('Account closure is not available yet.');
        }
        return NextResponse.json(apiErrorBody(ROUTE, writeError), { status: 500 });
      }
      if (!closed) {
        const { data: again, error: againError } = await supabase
          .from('accounts')
          .select('deleted_at, balance_eth')
          .eq('id', accountId)
          .maybeSingle();
        if (againError) {
          return NextResponse.json(apiErrorBody(ROUTE, againError), { status: 500 });
        }
        if (closureOf(again) === 'deleted') {
          return NextResponse.json({ error: 'This account was already deleted.' }, { status: 409 });
        }
        if (holdsInternalBalance(again?.balance_eth)) {
          return NextResponse.json(
            { error: 'This account still has a balance. Move it out, or deactivate.' },
            { status: 409 }
          );
        }
        return NextResponse.json({ error: 'This account could not be deleted.' }, { status: 409 });
      }
    } else {
      const now = new Date().toISOString();
      const { data: paused, error: writeError } = await supabase
        .from('accounts')
        .update({ deactivated_at: now })
        .eq('id', accountId)
        .is('deleted_at', null)
        .select('id')
        .maybeSingle();
      if (writeError) {
        if (isMissingClosureColumn(writeError)) {
          throw new ClientError('Account closure is not available yet.');
        }
        return NextResponse.json(apiErrorBody(ROUTE, writeError), { status: 500 });
      }
      // A delete that won the race updated zero rows. Do not report a pause.
      if (!paused) {
        return NextResponse.json({ error: 'This account was already deleted.' }, { status: 409 });
      }
    }

    try {
      await revokeAllSessions(accountId);
    } catch {
      // The pause flag is already set, so a leftover row stays refused.
      // Sign-in revokes those rows before it clears the flag.
      console.error('[closure] sessions were not all revoked');
    }
    await clearAccountCookie();
    return NextResponse.json({ ok: true, action: action === 'delete' ? 'deleted' : 'deactivated' });
  } catch (err) {
    return NextResponse.json(apiErrorBodyAllowingClientError(ROUTE, err), { status: 500 });
  }
}
