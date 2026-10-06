/**
 * Whether an account can still be used.
 *
 * deleted wins over deactivated. A row with neither timestamp is open.
 * A missing row is open so a lookup that has not loaded closure columns
 * does not pretend the account was closed.
 */

/** @param {{ deleted_at?: string | null, deactivated_at?: string | null } | null | undefined} row */
function closureOf(row) {
  if (!row) return 'open';
  if (row.deleted_at) return 'deleted';
  if (row.deactivated_at) return 'deactivated';
  return 'open';
}

/**
 * PostgREST / Postgres when the closure columns are not applied yet.
 * @param {{ message?: string, code?: string } | null | undefined} error
 */
function isMissingClosureColumn(error) {
  const code = String(error && error.code ? error.code : '');
  const message = String(error && error.message ? error.message : '');
  return code === '42703' || code === 'PGRST204' || /deleted_at|deactivated_at/.test(message);
}

module.exports = {
  closureOf,
  isMissingClosureColumn,
};
