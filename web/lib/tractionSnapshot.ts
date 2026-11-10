import type { SupabaseClient } from '@supabase/supabase-js';
import { TRACTION_DEFINITION_VERSION, computeTraction, type TractionInput } from './traction.ts';

/**
 * Keep each completed week's figures as they were computed, with and without
 * the excluded accounts, in metrics_weekly_snapshots. Weeks still running are
 * left out. A week already stored under this definition version is replaced,
 * so a re-run after a late payment lands is harmless; a new definition version
 * writes alongside, and the old figures stay.
 */
export async function writeTractionSnapshots(db: SupabaseClient, input: TractionInput): Promise<number> {
  const rows = [false, true].flatMap((exclude) =>
    computeTraction(input, { exclude })
      .weeks.filter((w) => !w.partial)
      .map((w) => ({ week_start: w.week_start, excluded: exclude, definition_version: TRACTION_DEFINITION_VERSION, metrics: w, computed_at: new Date(input.now).toISOString() }))
  );
  if (!rows.length) return 0;
  const { error } = await db.from('metrics_weekly_snapshots').upsert(rows, { onConflict: 'week_start,excluded,definition_version' });
  if (error) throw new Error(error.message || 'snapshot write failed');
  return rows.length;
}
