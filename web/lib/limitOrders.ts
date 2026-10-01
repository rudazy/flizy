import { ethers } from 'ethers';
import { getSupabase } from './supabase.ts';
import { ClientError } from './apiError.ts';

/**
 * Limit orders on the ETH/FLZ pool: placing, listing and cancelling them.
 *
 * Filling is not here. The bot's watcher (lib/limitOrders.js) checks open
 * orders and swaps one when the pool would return at least its min_out, with
 * min_out as the on-chain minimum. The route that places an order takes the
 * account password; nothing after that asks again.
 */

export type Db = ReturnType<typeof getSupabase>;

export type LimitSide = 'buy' | 'sell';

export type LimitOrderRow = {
  id: string;
  side: LimitSide;
  amount_in: string;
  min_out: string;
  status: 'open' | 'filling' | 'filled' | 'cancelled' | 'expired' | 'failed';
  expires_at: string;
  created_at: string;
  filled_at: string | null;
  tx_hash: string | null;
  error: string | null;
};

/** How long an order stands before it expires unfilled. The table caps it too. */
export const LIMIT_ORDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Open orders allowed per account. The insert trigger enforces the same number, plus 30 placed per hour. */
export const MAX_OPEN_LIMIT_ORDERS = 10;

/** Orders returned to the page: enough to show what is open and what just filled. */
const LIST_MAX = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function db(client?: Db): Db {
  return client || getSupabase();
}

/**
 * The least an order may receive, in the out token's smallest unit.
 *
 * `price` is how many of the out token one whole in token must fetch, as typed:
 * "500" on a buy means 1 ETH for at least 500 FLZ. Done in integers so a price
 * with many decimals is not rounded on the way through a float. Rounds down,
 * so the stored minimum is never above what the person asked for.
 */
export function minOutFromPrice(amountInWei: bigint, price: string, decimalsIn: number, decimalsOut: number): bigint {
  const clean = String(price || '').trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new ClientError('Enter a limit price.');
  let priceScaled: bigint;
  try {
    priceScaled = ethers.parseUnits(clean, 18);
  } catch {
    throw new ClientError('That limit price has too many decimals.');
  }
  if (priceScaled <= 0n) throw new ClientError('Enter a limit price.');
  const out = (amountInWei * priceScaled * 10n ** BigInt(decimalsOut)) / (10n ** 18n * 10n ** BigInt(decimalsIn));
  if (out <= 0n) throw new ClientError('That order is too small to fill.');
  return out;
}

export async function placeLimitOrder(
  accountId: string,
  input: { side: LimitSide; amountInWei: bigint; minOutWei: bigint },
  client?: Db,
  now = Date.now()
): Promise<{ id: string; expiresAt: string }> {
  if (input.side !== 'buy' && input.side !== 'sell') throw new ClientError('Pick buy or sell.');
  if (input.amountInWei <= 0n) throw new ClientError('Enter an amount.');
  if (input.minOutWei <= 0n) throw new ClientError('Enter a limit price.');

  const expiresAt = new Date(now + LIMIT_ORDER_TTL_MS).toISOString();
  const { data, error } = await db(client)
    .from('limit_orders')
    .insert({
      account_id: accountId,
      side: input.side,
      amount_in: input.amountInWei.toString(),
      min_out: input.minOutWei.toString(),
      status: 'open',
      created_at: new Date(now).toISOString(),
      expires_at: expiresAt,
    })
    .select('id')
    .maybeSingle();
  if (error) {
    if (/limit_orders_cap/.test(error.message || '')) {
      throw new ClientError(`You can have ${MAX_OPEN_LIMIT_ORDERS} open limit orders at once.`);
    }
    if (/limit_orders_rate/.test(error.message || '')) {
      throw new ClientError('You have placed a lot of limit orders in the last hour. Try again later.');
    }
    throw new Error(error.message);
  }
  if (!data) throw new Error('limit order insert returned no row');
  return { id: String((data as { id: string }).id), expiresAt };
}

export async function listLimitOrders(accountId: string, client?: Db): Promise<LimitOrderRow[]> {
  const { data, error } = await db(client)
    .from('limit_orders')
    .select('id, side, amount_in, min_out, status, expires_at, created_at, filled_at, tx_hash, error')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(LIST_MAX);
  if (error) throw new Error(error.message);
  return (data || []) as LimitOrderRow[];
}

/**
 * Cancel an open order. Only from open: an order the watcher has already
 * claimed is mid-swap and cannot be pulled back, and the account is checked
 * in the same statement so one account cannot cancel another's.
 */
export async function cancelLimitOrder(accountId: string, orderId: string, client?: Db): Promise<void> {
  if (!UUID.test(String(orderId || ''))) throw new ClientError('Order not found.');
  const { data, error } = await db(client)
    .from('limit_orders')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('account_id', accountId)
    .eq('status', 'open')
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ClientError('That order is no longer open.');
}
