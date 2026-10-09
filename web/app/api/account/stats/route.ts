/**
 * Swaps and ETH volume for the signed-in account's own card. Reads only rows
 * the account wrote, and returns two numbers.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { summarizeAccountStats, type StatsRow } from '../../../../lib/accountStats.ts';

const ROUTE = 'GET /api/account/stats';

/** Rows read per account. Far above any account today; a cap, not a lifetime promise. */
const STATS_ROWS = 2000;

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const { data, error } = await getSupabase()
      .from('transfers')
      .select('kind, status, asset, amount_eth, amount_secondary, asset_secondary')
      .eq('account_id', accountId)
      .eq('status', 'confirmed')
      .limit(STATS_ROWS);
    if (error) return NextResponse.json(apiErrorBody(ROUTE, error), { status: 500 });
    const stats = summarizeAccountStats((data || []) as StatsRow[]);
    // Money sent to someone not on Flizy yet is a claim, held until they take
    // it. It is still a send; a cancelled one is not.
    const claims = await getSupabase()
      .from('claims')
      .select('id', { count: 'exact', head: true })
      .eq('from_account_id', accountId)
      .neq('status', 'cancelled');
    if (!claims.error) stats.sends += claims.count || 0;
    return NextResponse.json(stats);
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
