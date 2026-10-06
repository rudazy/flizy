/**
 * Web copy of lib/accountClosure.js.
 *
 * The site deploy does not include the repo lib folder, so this predicate
 * lives here too. test/accountClosure.test.js checks the two copies agree.
 */

export type ClosureState = 'open' | 'deactivated' | 'deleted';

export function closureOf(
  row: { deleted_at?: string | null; deactivated_at?: string | null } | null | undefined
): ClosureState {
  if (!row) return 'open';
  if (row.deleted_at) return 'deleted';
  if (row.deactivated_at) return 'deactivated';
  return 'open';
}

export function isMissingClosureColumn(
  error: { message?: string; code?: string } | null | undefined
): boolean {
  const code = String(error && error.code ? error.code : '');
  const message = String(error && error.message ? error.message : '');
  return code === '42703' || code === 'PGRST204' || /deleted_at|deactivated_at/.test(message);
}
