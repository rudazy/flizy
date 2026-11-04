/**
 * Flizy Pay API: who this key belongs to. The first v1 endpoint, so an
 * integrator can check a key works. Needs the `read` permission.
 *
 * Answers the platform's Flizy-assigned name, its approved wallet, the key's
 * own mode, prefix and permissions, and whether API payouts are switched on.
 * Nothing about other keys, other platforms or Flizy accounts.
 */

import { getSupabase } from '../../../../lib/supabase';
import { apiError, apiJson, authenticateApiRequest, logApiRequest, payoutsEnabled } from '../../../../lib/apiAuth.ts';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const db = getSupabase();
  const auth = await authenticateApiRequest(req, db, 'read');
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const body = {
      object: 'platform',
      name: caller.platformName,
      wallet: caller.walletAddress,
      key: { prefix: caller.prefix, mode: caller.mode, permissions: caller.scopes },
      payouts_enabled: (await payoutsEnabled(db)) && caller.scopes.includes('payout'),
    };
    await logApiRequest(db, req, caller, 200);
    return apiJson(body, caller.requestId);
  } catch {
    await logApiRequest(db, req, caller, 500);
    return apiError(500, 'internal_error', 'Something went wrong. Try again.', caller.requestId);
  }
}
