import { revokeAllSessions } from './cookies';
import { getSupabase } from './supabase';
import { isMissingClosureColumn } from './accountClosure.ts';
import { logApiError } from './apiError';

/**
 * Bring a paused account back when its owner signs in: every old session is
 * dropped first, then the pause is cleared. Called only once the sign-in is
 * complete (for Google, after the emailed code when one was asked for).
 * Returns false on any failure; nothing is half done that matters, because
 * no session has been opened yet.
 */
export async function restoreAccount(accountId: string, route: string): Promise<boolean> {
  try {
    await revokeAllSessions(accountId);
  } catch (err) {
    logApiError(route, err);
    return false;
  }
  const { data, error } = await getSupabase()
    .from('accounts')
    .update({ deactivated_at: null, deleted_at: null })
    .eq('id', accountId)
    .select('id')
    .maybeSingle();
  if (error && isMissingClosureColumn(error)) return true;
  if (error) {
    logApiError(route, error);
    return false;
  }
  return Boolean(data?.id);
}
