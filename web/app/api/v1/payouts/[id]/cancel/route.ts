/**
 * Flizy Pay API: cancel one of this platform's payouts. Needs `payout`.
 *
 *   accepted        not taken by the worker yet: failed, error_code `cancelled`;
 *                   nothing was sent
 *   claim_pending   an unclaimed claim: the cancel is recorded and the VPS worker
 *                   locks the claim and refunds it from escrow to the platform's
 *                   wallet (refund_pending, then refunded once confirmed on chain)
 *   expired, refund_pending, refunded
 *                   already coming back: answered as it is
 *   anything else   409: being sent, sent, or failed
 *
 * Asking twice is harmless, so no Idempotency-Key is needed. A cancel that
 * arrives after the recipient claimed changes nothing: the claim is theirs.
 */

import { getSupabase } from '../../../../../../lib/supabase';
import { apiError, apiJson, authenticateApiRequest, logApiRequest } from '../../../../../../lib/apiAuth.ts';
import { PAYOUT_COLUMNS, payoutView, type PayoutRow } from '../../../../../../lib/apiPayouts.ts';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getSupabase();
  const auth = await authenticateApiRequest(req, db, 'payout');
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  const answer = async (res: Response) => {
    await logApiRequest(db, req, caller, res.status);
    return res;
  };
  try {
    const { id } = await params;
    if (!UUID.test(String(id || ''))) return answer(apiError(404, 'not_found', 'No such payout.', caller.requestId));
    const read = async () => {
      const { data, error } = await db
        .from('api_transactions')
        .select(PAYOUT_COLUMNS)
        .eq('id', id)
        .eq('platform_id', caller.platformId)
        .eq('kind', 'payout')
        .maybeSingle();
      if (error) throw new Error('payout read failed');
      return data as PayoutRow | null;
    };
    const row = await read();
    if (!row) return answer(apiError(404, 'not_found', 'No such payout.', caller.requestId));

    if (row.state === 'accepted') {
      // api_transition locks the row, so a worker that took it first wins and
      // the move from accepted is refused.
      const { error } = await db.rpc('api_transition', {
        p_transaction_id: row.id,
        p_to_state: 'failed',
        p_detail: { error_code: 'cancelled' },
      });
      if (error) return answer(apiError(409, 'in_progress', 'This payout is already being sent and cannot be cancelled now.', caller.requestId));
      await db.from('api_transactions').update({ error_code: 'cancelled', updated_at: new Date().toISOString() }).eq('id', row.id);
    } else if (row.state === 'claim_pending') {
      if (!row.cancel_requested_at) {
        await db
          .from('api_transactions')
          .update({ cancel_requested_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('state', 'claim_pending')
          .is('cancel_requested_at', null);
      }
    } else if (!['expired', 'refund_pending', 'refunded'].includes(row.state)) {
      return answer(apiError(409, 'not_cancellable', `A payout that is ${row.state} cannot be cancelled.`, caller.requestId));
    }
    const now = await read();
    return answer(apiJson(payoutView(now as PayoutRow), caller.requestId, 202));
  } catch {
    return answer(apiError(500, 'internal_error', 'Something went wrong. Try again.', caller.requestId));
  }
}
