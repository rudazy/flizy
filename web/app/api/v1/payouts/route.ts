/**
 * Flizy Pay API: create a payout (POST) and list this platform's payouts (GET).
 *
 * POST needs the `payout` permission and an Idempotency-Key. It validates and
 * records the payout as `accepted`, and answers 202 the same way whoever the
 * recipient is: the recipient is resolved and paid later by the VPS worker
 * (lib/api/payoutWorker.js), only through the platform's passkey-signed
 * allowance. `accepted` is never a completed payment; follow the payout with
 * GET /api/v1/payouts/{id}.
 *
 * GET needs `read` and lists newest first: ?limit (1 to 100, default 20) and
 * ?before (an ISO time, for the next page).
 */

import { getSupabase } from '../../../../lib/supabase';
import { apiError, apiJson, authenticateApiRequest, logApiRequest, payoutsEnabled } from '../../../../lib/apiAuth.ts';
import { abandonIdempotent, beginIdempotent, finishIdempotent, requestHash } from '../../../../lib/apiIdempotency.ts';
import { PAYOUT_COLUMNS, PayoutRequestError, largePayoutMail, parsePayoutRequest, payoutView, type PayoutRow } from '../../../../lib/apiPayouts.ts';
import { displaySafeLabel } from '../../../../lib/sanitize.ts';
import { mailOwner } from '../../../../lib/securityNotice';
import { siteOrigin } from '../../../../lib/siteOrigin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PATH = '/api/v1/payouts';
const BODY_MAX_BYTES = 16 * 1024;

export async function POST(req: Request) {
  const db = getSupabase();
  const auth = await authenticateApiRequest(req, db, 'payout');
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const idemKey = req.headers.get('idempotency-key');
  const answer = async (res: Response) => {
    await logApiRequest(db, req, caller, res.status, idemKey);
    return res;
  };

  try {
    if (!(await payoutsEnabled(db))) {
      return answer(apiError(503, 'payouts_disabled', 'Payouts are switched off on Flizy. Try again later.', caller.requestId));
    }
    if (!idemKey) return answer(apiError(400, 'idempotency_key_required', 'Send an Idempotency-Key header.', caller.requestId));

    const text = await req.text();
    if (Buffer.byteLength(text, 'utf8') > BODY_MAX_BYTES) {
      return answer(apiError(413, 'body_too_large', `The body must be at most ${BODY_MAX_BYTES} bytes.`, caller.requestId));
    }
    let parsed;
    try {
      parsed = parsePayoutRequest(JSON.parse(text));
    } catch (err) {
      if (err instanceof PayoutRequestError) return answer(apiError(400, err.code, err.message, caller.requestId));
      return answer(apiError(400, 'invalid_json', 'The body must be valid JSON.', caller.requestId));
    }

    // Flizy's limits for this platform: no row means the asset is not enabled.
    const { data: limits, error: limErr } = await db
      .from('api_platform_limits')
      .select('max_payout, notice_at')
      .eq('platform_id', caller.platformId)
      .eq('symbol', parsed.symbol)
      .maybeSingle();
    if (limErr) return answer(apiError(503, 'unavailable', 'Try again shortly.', caller.requestId));
    if (!limits) return answer(apiError(400, 'asset_not_enabled', 'Payouts in this asset are not enabled for your platform.', caller.requestId));
    if (parsed.amount > BigInt(limits.max_payout)) {
      return answer(apiError(400, 'over_max_payout', 'The amount is over the most one payout may move for your platform.', caller.requestId));
    }
    if (parsed.claimExpiryDays != null) {
      const { data: plat, error: platErr } = await db.from('api_platforms').select('claim_expiry_max_days').eq('id', caller.platformId).maybeSingle();
      if (platErr || !plat) return answer(apiError(503, 'unavailable', 'Try again shortly.', caller.requestId));
      if (parsed.claimExpiryDays > Number(plat.claim_expiry_max_days)) {
        return answer(
          apiError(400, 'invalid_claim_expiry', `claim_expiry_days can be at most ${plat.claim_expiry_max_days} for your platform.`, caller.requestId)
        );
      }
    }

    const idem = await beginIdempotent(db, caller.keyId, idemKey, requestHash('POST', PATH, text));
    if (idem.kind === 'invalid') return answer(apiError(400, 'invalid_idempotency_key', 'Idempotency-Key must be 1 to 255 visible ASCII characters.', caller.requestId));
    if (idem.kind === 'conflict') return answer(apiError(409, 'idempotency_conflict', 'This Idempotency-Key was used for a different request.', caller.requestId));
    if (idem.kind === 'in_progress') return answer(apiError(409, 'idempotency_in_progress', 'A request with this Idempotency-Key is still being handled.', caller.requestId));
    if (idem.kind === 'unavailable') return answer(apiError(503, 'unavailable', 'Try again shortly.', caller.requestId));
    if (idem.kind === 'replay') return answer(apiJson(idem.body, caller.requestId, idem.status));

    const { data: row, error: insErr } = await db
      .from('api_transactions')
      .insert({
        platform_id: caller.platformId,
        key_id: caller.keyId,
        kind: 'payout',
        state: 'accepted',
        idempotency_key: idemKey,
        reference: parsed.reference,
        request: { asset: parsed.symbol, amount: parsed.amount.toString(), recipient_type: parsed.recipient.type },
        recipient_kind: parsed.recipient.type,
        recipient_ref: parsed.recipient.value,
        amount: parsed.amount.toString(),
        asset: parsed.symbol,
        metadata: parsed.metadata,
        claim_expiry_days: parsed.claimExpiryDays,
      })
      .select(PAYOUT_COLUMNS)
      .single();
    if (insErr?.code === '23505') {
      // The key's 24-hour record expired, but a payout already carries this
      // Idempotency-Key: the platform reused it for a new request.
      await abandonIdempotent(db, caller.keyId, idemKey);
      return answer(apiError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used for an earlier payout. Use a new one.', caller.requestId));
    }
    if (insErr || !row) {
      await abandonIdempotent(db, caller.keyId, idemKey);
      return answer(apiError(503, 'unavailable', 'Try again shortly.', caller.requestId));
    }
    const body = payoutView(row as PayoutRow);
    await finishIdempotent(db, caller.keyId, idemKey, 202, body);
    // A large payout is mailed to the owner as it is accepted. A failed mail
    // never changes the answer: the payout is already recorded.
    if (limits.notice_at && parsed.amount >= BigInt(limits.notice_at)) {
      try {
        const { data: plat } = await db.from('api_platforms').select('account_id, display_name').eq('id', caller.platformId).maybeSingle();
        if (plat) await mailOwner(db, plat.account_id, largePayoutMail(body, displaySafeLabel(plat.display_name, 60), siteOrigin()));
      } catch {
        // Best effort, as for key notices.
      }
    }
    return answer(apiJson(body, caller.requestId, 202));
  } catch {
    return answer(apiError(500, 'internal_error', 'Something went wrong. Try again.', caller.requestId));
  }
}

export async function GET(req: Request) {
  const db = getSupabase();
  const auth = await authenticateApiRequest(req, db, 'read');
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get('limit') ?? 20);
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : null;
    if (limit == null) {
      await logApiRequest(db, req, caller, 400);
      return apiError(400, 'invalid_limit', 'limit must be a whole number from 1 to 100.', caller.requestId);
    }
    const before = url.searchParams.get('before');
    if (before != null && Number.isNaN(Date.parse(before))) {
      await logApiRequest(db, req, caller, 400);
      return apiError(400, 'invalid_before', 'before must be an ISO time.', caller.requestId);
    }
    let query = db
      .from('api_transactions')
      .select(PAYOUT_COLUMNS)
      .eq('platform_id', caller.platformId)
      .eq('kind', 'payout')
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (before) query = query.lt('created_at', new Date(before).toISOString());
    const { data, error } = await query;
    if (error) {
      await logApiRequest(db, req, caller, 503);
      return apiError(503, 'unavailable', 'Try again shortly.', caller.requestId);
    }
    const rows = (data as PayoutRow[]) || [];
    await logApiRequest(db, req, caller, 200);
    return apiJson({ object: 'list', data: rows.slice(0, limit).map(payoutView), has_more: rows.length > limit }, caller.requestId);
  } catch {
    await logApiRequest(db, req, caller, 500);
    return apiError(500, 'internal_error', 'Something went wrong. Try again.', caller.requestId);
  }
}
