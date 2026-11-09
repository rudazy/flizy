/**
 * Flizy Pay API: one payment of this platform, by id. Needs `read`. Another
 * platform's payment, or an id that does not exist, is the same 404.
 */

import { getSupabase } from '../../../../../lib/supabase';
import { apiError, apiJson, authenticateApiRequest, logApiRequest } from '../../../../../lib/apiAuth.ts';
import { PAYMENT_COLUMNS, paymentView, type PaymentRow } from '../../../../../lib/apiPayments.ts';
import { siteOrigin } from '../../../../../lib/siteOrigin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getSupabase();
  const auth = await authenticateApiRequest(req, db, 'read');
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const { id } = await params;
    const notFound = async () => {
      await logApiRequest(db, req, caller, 404);
      return apiError(404, 'not_found', 'No such payment.', caller.requestId);
    };
    if (!UUID.test(String(id || ''))) return notFound();
    const { data, error } = await db
      .from('api_transactions')
      .select(PAYMENT_COLUMNS)
      .eq('id', id)
      .eq('platform_id', caller.platformId)
      .eq('kind', 'payment')
      .maybeSingle();
    if (error) {
      await logApiRequest(db, req, caller, 503);
      return apiError(503, 'unavailable', 'Try again shortly.', caller.requestId);
    }
    if (!data) return notFound();
    await logApiRequest(db, req, caller, 200);
    return apiJson(paymentView(data as PaymentRow, siteOrigin()), caller.requestId);
  } catch {
    await logApiRequest(db, req, caller, 500);
    return apiError(500, 'internal_error', 'Something went wrong. Try again.', caller.requestId);
  }
}
