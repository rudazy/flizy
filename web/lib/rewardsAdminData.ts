import type { SupabaseClient } from '@supabase/supabase-js';
import type { RewardsAdminInput } from './rewardsAdmin.ts';

/**
 * The rows the private rewards figures are computed from (web/lib/rewardsAdmin.ts),
 * read with the service role. Server only. Amounts, times and account ids:
 * no transaction, address, phone or email is read.
 */

const PAGE = 1000;

/** Every row a query returns, a page at a time. */
async function all<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message?: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message || 'rewards read failed');
    const rows = (data as T[]) || [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function loadRewardsAdminInput(db: SupabaseClient, now = Date.now()): Promise<RewardsAdminInput> {
  const [fees, rewards, excluded] = await Promise.all([
    all<{ account_id: string | null; fee_usd_micro: string | number; net_usd_micro: string | number | null; settled_at: string | null }>((a, b) =>
      db.from('fee_ledger').select('account_id, fee_usd_micro, net_usd_micro, settled_at').eq('state', 'charged').order('id').range(a, b)
    ),
    all<{ account_id: string; kind: RewardsAdminInput['rewards'][number]['kind']; usd_micro: string | number; created_at: string }>((a, b) =>
      db.from('reward_entries').select('account_id, kind, usd_micro, created_at').order('id').range(a, b)
    ),
    all<{ account_id: string }>((a, b) => db.from('metrics_excluded_accounts').select('account_id').order('account_id').range(a, b)),
  ]);
  return {
    now,
    fees: fees.map((f) => ({
      accountId: f.account_id,
      feeMicro: Number(f.fee_usd_micro),
      netMicro: f.net_usd_micro == null ? null : Number(f.net_usd_micro),
      at: f.settled_at,
    })),
    rewards: rewards.map((r) => ({ accountId: r.account_id, kind: r.kind, micro: Number(r.usd_micro), at: r.created_at })),
    excluded: excluded.map((e) => e.account_id),
  };
}

/**
 * The usernames of the top earners, for the page only. An account without a
 * username has none here.
 */
export async function loadUsernames(db: SupabaseClient, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const { data, error } = await db.from('accounts').select('id, username').in('id', ids);
  if (error) throw new Error(error.message || 'usernames read failed');
  const out: Record<string, string> = {};
  for (const a of (data || []) as Array<{ id: string; username: string | null }>) if (a.username) out[a.id] = a.username;
  return out;
}
