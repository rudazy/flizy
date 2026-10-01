import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { getWebChain, getDexAddresses, readErc20Decimals, assertSwapAllowed } from '../../../../lib/dexServer';
import { apiErrorBody, apiErrorBodyAllowingClientError, ClientError } from '../../../../lib/apiError';
import { requirePassword } from '../../../../lib/passwordGate.ts';
import {
  cancelLimitOrder,
  listLimitOrders,
  minOutFromPrice,
  placeLimitOrder,
  type LimitSide,
} from '../../../../lib/limitOrders';

const LIST_ROUTE = 'GET /api/swap/limit';
const POST_ROUTE = 'POST /api/swap/limit';

/** ETH and FLZ decimals, read once per request: FLZ's from its contract. */
async function pairDecimals() {
  const chain = getWebChain();
  const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
  const dex = getDexAddresses();
  const flz = await readErc20Decimals(provider, dex.flz);
  return { eth: 18, flz, dex };
}

/** The signed-in account's orders, newest first, with amounts in whole units. */
export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const [rows, decimals] = await Promise.all([listLimitOrders(accountId), pairDecimals()]);
    const orders = rows.map((r) => {
      const inDecimals = r.side === 'buy' ? decimals.eth : decimals.flz;
      const outDecimals = r.side === 'buy' ? decimals.flz : decimals.eth;
      return {
        id: r.id,
        side: r.side,
        tokenIn: r.side === 'buy' ? 'ETH' : 'FLZ',
        tokenOut: r.side === 'buy' ? 'FLZ' : 'ETH',
        amountIn: ethers.formatUnits(BigInt(r.amount_in), inDecimals),
        minOut: ethers.formatUnits(BigInt(r.min_out), outDecimals),
        status: r.status,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        filledAt: r.filled_at,
        txHash: r.tx_hash,
        error: r.error,
      };
    });
    return NextResponse.json({ orders });
  } catch (err) {
    return NextResponse.json(apiErrorBody(LIST_ROUTE, err), { status: 500 });
  }
}

/**
 * Place or cancel. Placing takes the account password, because the watcher
 * will later swap from this wallet without asking again; cancelling does not,
 * since it only ever takes authority away.
 */
export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;

    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'cancel') {
      await cancelLimitOrder(accountId, String(body.id || ''));
      return NextResponse.json({ ok: true });
    }
    if (action !== 'place') throw new ClientError('Unknown action.');

    const side = String(body.side || '') as LimitSide;
    if (side !== 'buy' && side !== 'sell') throw new ClientError('Pick buy or sell.');

    const { eth, flz, dex } = await pairDecimals();
    const gate = assertSwapAllowed(accountId, dex.feeRouter);
    if (!gate.ok) return NextResponse.json({ error: gate.message }, { status: 403 });

    const inDecimals = side === 'buy' ? eth : flz;
    const outDecimals = side === 'buy' ? flz : eth;
    let amountInWei: bigint;
    try {
      amountInWei = ethers.parseUnits(String(body.amount || '').trim(), inDecimals);
    } catch {
      throw new ClientError('Enter an amount.');
    }
    if (amountInWei <= 0n) throw new ClientError('Enter an amount.');
    const minOutWei = minOutFromPrice(amountInWei, String(body.price || ''), inDecimals, outDecimals);

    const supabase = getSupabase();
    const auth = await requirePassword(supabase, accountId, String(body.password || ''), 'place a limit order');
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error, code: auth.code }, { status: auth.status });
    }

    const placed = await placeLimitOrder(accountId, { side, amountInWei, minOutWei }, supabase);
    return NextResponse.json({ ok: true, id: placed.id, expiresAt: placed.expiresAt });
  } catch (err) {
    const status = err instanceof ClientError ? 400 : 500;
    return NextResponse.json(apiErrorBodyAllowingClientError(POST_ROUTE, err), { status });
  }
}
