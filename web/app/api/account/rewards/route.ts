/**
 * Account > Rewards: the signed-in account's points and its latest entries
 * (lib/rewardsView.js, the same reader as the chat command).
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadRewards, TESTNET_NOTE, HOW_TO_EARN } = require('../../../../../lib/rewardsView');

const LIMIT = 25;

export async function GET() {
  try {
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const view = await loadRewards(getSupabase(), accountId, { limit: LIMIT });
    return NextResponse.json({ ...view, note: TESTNET_NOTE, howToEarn: HOW_TO_EARN });
  } catch (err) {
    return NextResponse.json(apiErrorBody('GET /api/account/rewards', err), { status: 500 });
  }
}
