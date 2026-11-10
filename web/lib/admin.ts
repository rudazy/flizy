import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Whether an account is a Flizy admin: accounts.is_admin, which is set by hand
 * in the SQL editor and nowhere in the app. The same check web/lib/tasks.ts
 * makes for task review. A read that fails answers false.
 */
export async function isAdminAccount(db: SupabaseClient, accountId: string | null): Promise<boolean> {
  if (!accountId) return false;
  const { data, error } = await db.from('accounts').select('is_admin').eq('id', accountId).maybeSingle();
  if (error || !data) return false;
  return (data as { is_admin?: boolean | null }).is_admin === true;
}
