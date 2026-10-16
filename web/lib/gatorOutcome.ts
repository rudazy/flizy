/**
 * What site routes do with the smart-account executor's outcomes
 * (web/lib/gatorExecute.ts).
 *
 * - markTransferSubmitted is the onBroadcast hook: the transfers row gets the
 *   tx hash before the transaction is broadcast, and a row that cannot be
 *   marked stops the broadcast. A send whose outcome is unknown always has a
 *   row for the reconciler (lib/reconcile.js) to settle by hash.
 * - gatorFailure turns an executor error into the response a route returns:
 *   409 with pending: true and the "still confirming" copy when the outcome is
 *   unknown (the row stays 'submitted'; a 2xx would read as done on the
 *   money screens, which treat any 2xx as success and show their error text
 *   otherwise), 400 with the refusal copy when nothing was sent, and
 *   null for anything else so the route keeps its own handling. Only the
 *   fixed copy reaches the client, never RPC text.
 *
 * Plain TypeScript with no Next import, so node --test can load it; routes
 * build the response from gatorFailure themselves.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { gatorErrorCopy, outcomeUnknown } from './gatorExecute.ts';

export async function markTransferSubmitted(supabase: SupabaseClient, id: string, txHash: string): Promise<void> {
  const { data, error } = await supabase
    .from('transfers')
    .update({ status: 'submitted', tx_hash: txHash })
    .eq('id', id)
    .select('id');
  if (error || !data || !data.length) {
    throw new Error(`transfer ${id} not marked submitted`);
  }
}

export function gatorFailure(err: unknown): { status: number; body: { error: string; code: string; pending?: true } } | null {
  const copy = gatorErrorCopy(err);
  if (!copy) return null;
  const code = String((err as { code?: string }).code || '');
  if (outcomeUnknown(err)) return { status: 409, body: { error: copy, code, pending: true } };
  return { status: 400, body: { error: copy, code } };
}

