/**
 * Flizy Pay API: create a payment (a checkout, POST) and list this platform's
 * payments (GET).
 *
 * POST needs the `collect` permission and an Idempotency-Key. It records the
 * payment as `accepted` with a fresh invoice id and answers 201 with its
 * checkout_url: send the customer there. The money goes straight from the
 * customer's wallet to the platform's approved wallet through
 * FlizyPaymentReceiver; Flizy never holds it. Follow it with
 * GET /api/v1/payments/{id} or the payment.* webhooks. A return_url must be on
 * an origin the platform registered on the Developers page.
 *
 * GET needs `read` and lists newest first: ?limit (1 to 100, default 20) and
 * ?before (an ISO time, for the next page).
 */

import { getSupabase } from '../../../../lib/supabase';
import { apiError, apiJson, authenticateApiRequest, logApiRequest } from '../../../../lib/apiAuth.ts';
import { abandonIdempotent, beginIdempotent, finishIdempotent, requestHash } from '../../../../lib/apiIdempotency.ts';
import { PayoutRequestError } from '../../../../lib/apiPayouts.ts';
import { PAYMENT_COLUMNS, allowedReturnUrl, newInvoiceId, parsePaymentRequest, paymentView, type PaymentRow } from '../../../../lib/apiPayments.ts';
import { siteOrigin } from '../../../../lib/siteOrigin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PATH = '/api/v1/payments';
const BODY_MAX_BYTES = 16 * 1024;

export async function POST(req: Request) {
  const db = getSupabase();
  const auth = await authenticateApiRequest(req, db, 'collect');
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const idemKey = req.headers.get('idempotency-key');
  const answer = async (res: Response) => {
    await logApiRequest(db, req, caller, res.status, idemKey);
    return res;
  };

  try {
    if (!idemKey) return answer(apiError(400, 'idempotency_key_required', 'Send an Idempotency-Key header.', caller.requestId));
    const text = await req.text();
    if (Buffer.byteLength(text, 'utf8') > BODY_MAX_BYTES) {
      return answer(apiError(413, 'body_too_large', `The body must be at most ${BODY_MAX_BYTES} bytes.`, caller.requestId));
    }
    let parsed;
    try {
      parsed = parsePaymentRequest(JSON.parse(text));
    } catch (err) {
      if (err instanceof PayoutRequestError) return answer(apiError(400, err.code, err.message, caller.requestId));
      return answer(apiError(400, 'invalid_json', 'The body must be valid JSON.', caller.requestId));
    }

    let returnUrl: string | null = null;
    if (parsed.returnUrl) {
      const { data: origins, error: oErr } = await db.from('api_platform_origins').select('origin').eq('platform_id', caller.platformId);
      if (oErr) return answer(apiError(503, 'unavailable', 'Try again shortly.', caller.requestId));
      returnUrl = allowedReturnUrl(parsed.returnUrl, (origins || []).map((o) => String(o.origin)));
      if (!returnUrl) {
        return answer(apiError(400, 'invalid_return_url', 'return_url must be https on an origin registered on the Developers page.', caller.requestId));
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
        kind: 'payment',
        state: 'accepted',
        idempotency_key: idemKey,
        reference: parsed.reference,
        request: { asset: parsed.symbol, amount: parsed.amount.toString(), expires_in_minutes: parsed.expiresInMinutes },
        amount: parsed.amount.toString(),
        asset: parsed.symbol,
        metadata: parsed.metadata,
        invoice_id: newInvoiceId(),
        expires_at: new Date(Date.now() + parsed.expiresInMinutes * 60 * 1000).toISOString(),
        return_url: returnUrl,
      })
      .select(PAYMENT_COLUMNS)
      .single();
    if (insErr?.code === '23505') {
      await abandonIdempotent(db, caller.keyId, idemKey);
      return answer(apiError(409, 'idempotency_key_reused', 'This Idempotency-Key was already used for an earlier request. Use a new one.', caller.requestId));
    }
    if (insErr || !row) {
      await abandonIdempotent(db, caller.keyId, idemKey);
      return answer(apiError(503, 'unavailable', 'Try again shortly.', caller.requestId));
    }
    const body = paymentView(row as PaymentRow, siteOrigin());
    await finishIdempotent(db, caller.keyId, idemKey, 201, body);
    return answer(apiJson(body, caller.requestId, 201));
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
      .select(PAYMENT_COLUMNS)
      .eq('platform_id', caller.platformId)
      .eq('kind', 'payment')
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (before) query = query.lt('created_at', new Date(before).toISOString());
    const { data, error } = await query;
    if (error) {
      await logApiRequest(db, req, caller, 503);
      return apiError(503, 'unavailable', 'Try again shortly.', caller.requestId);
    }
    const rows = (data as PaymentRow[]) || [];
    await logApiRequest(db, req, caller, 200);
    return apiJson({ object: 'list', data: rows.slice(0, limit).map((r) => paymentView(r, siteOrigin())), has_more: rows.length > limit }, caller.requestId);
  } catch {
    await logApiRequest(db, req, caller, 500);
    return apiError(500, 'internal_error', 'Something went wrong. Try again.', caller.requestId);
  }
}
