/**
 * POST /api/claim/shared
 * Body: { claimId, channel }  channel: share_link | whatsapp | telegram
 *
 * Notes on a claim's timeline that its sender shared the link from the site
 * (web/components/ShareClaimCard.tsx). Only the sender's own pending claims,
 * and at most MAX_SHARES per claim, so the timeline cannot be flooded.
 */

import { NextResponse } from 'next/server';
import { getAccountIdFromCookie } from '../../../../lib/cookies';
import { getSupabase } from '../../../../lib/supabase';
import { apiErrorBody } from '../../../../lib/apiError';
import { rejectIfCrossOrigin } from '../../../../lib/requestOrigin.ts';
import { recordClaimEvent } from '../../../../../lib/claimEvents.js';

const ROUTE = 'POST /api/claim/shared';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHANNELS = new Set(['share_link', 'whatsapp', 'telegram']);
const MAX_SHARES = 20;

export async function POST(req: Request) {
  try {
    const denied = rejectIfCrossOrigin(req);
    if (denied) return denied;
    const accountId = await getAccountIdFromCookie();
    if (!accountId) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const claimId = String(body.claimId || '').trim();
    const channel = String(body.channel || '').trim();
    if (!UUID.test(claimId) || !CHANNELS.has(channel)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const db = getSupabase();
    const { data: claim, error } = await db.from('claims').select('id, from_account_id, status').eq('id', claimId).maybeSingle();
    if (error) throw new Error(error.message);
    // Someone else's claim reads the same as no claim.
    if (!claim || claim.from_account_id !== accountId) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (claim.status !== 'pending') return NextResponse.json({ ok: true, recorded: false });

    const { count, error: countErr } = await db
      .from('claim_events')
      .select('id', { count: 'exact', head: true })
      .eq('claim_id', claimId)
      .eq('event', 'link_shared');
    if (countErr) throw new Error(countErr.message);
    if ((count || 0) >= MAX_SHARES) return NextResponse.json({ ok: true, recorded: false });

    const out = await recordClaimEvent(db, claimId, 'link_shared', { channel });
    return NextResponse.json({ ok: true, recorded: out === 'recorded' });
  } catch (err) {
    return NextResponse.json(apiErrorBody(ROUTE, err), { status: 500 });
  }
}
