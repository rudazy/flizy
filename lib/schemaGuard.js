/**
 * Startup schema guard.
 *
 * Compares the object list this build depends on against what the database
 * actually has, in one round trip, before the process starts serving anyone.
 *
 * The required list is not written by hand. It is derived from source by
 * lib/schemaRequirements.js and cached into lib/generated/schemaManifest.json
 * by scripts/generate-schema-manifest.js. A test in the suite re-derives it and
 * fails if the cached copy has drifted, so adding a table and forgetting to
 * regenerate breaks the build rather than the guard.
 *
 * There is no bypass. A missing object stops the process.
 */

const GUARD_FUNCTION = 'schema_guard_objects';

/** Where a required object of this kind can legitimately show up. */
const PRESENCE_KEYS = {
  table: ['tables', 'views'],
  view: ['views'],
  function: ['functions'],
  trigger: ['triggers'],
};

/**
 * @param {{ kind: string, name: string, providedBy: string, requiredBy: string }[]} required
 * @param {Record<string, string[]>} present
 */
function diffObjects(required, present) {
  const sets = {};
  for (const [k, v] of Object.entries(present)) {
    if (Array.isArray(v)) sets[k] = new Set(v);
  }

  return required.filter((object) => {
    const keys = PRESENCE_KEYS[object.kind];
    if (!keys) {
      throw new Error(`schema guard: unknown object kind "${object.kind}"`);
    }
    return !keys.some((k) => sets[k] && sets[k].has(object.name));
  });
}

/** The operator-facing failure. Names the object and the file that supplies it. */
function formatMissing(missing, surface) {
  const lines = [
    `SCHEMA GUARD: database is missing ${missing.length} object` +
      `${missing.length === 1 ? '' : 's'} required by this code (${surface}).`,
    '',
  ];

  for (const object of missing) {
    lines.push(`  ${object.kind} ${object.name}`);
    lines.push(`    required by  ${object.requiredBy}`);
    lines.push(`    provided by  supabase/migrations/${object.providedBy}`);
    lines.push('');
  }

  const files = [...new Set(missing.map((o) => o.providedBy))].sort();
  lines.push(
    files.length === 1
      ? 'Apply that migration in the Supabase SQL editor, then start again.'
      : 'Apply those migrations in the Supabase SQL editor, then start again.'
  );
  return lines.join('\n');
}

/** Failure when the guard's own function is not there yet. */
function formatGuardUnavailable(reason, providedBy) {
  return [
    `SCHEMA GUARD: cannot call public.${GUARD_FUNCTION}().`,
    '',
    `  ${reason}`,
    '',
    'That function is the guard itself. It is provided by',
    `  supabase/migrations/${providedBy}`,
    'Apply it in the Supabase SQL editor, then start again.',
  ].join('\n');
}

function guardError(message) {
  const err = new Error(message);
  // Entrypoints print message only: a stack trace buries the operator instruction.
  err.schemaGuard = true;
  return err;
}

/** Which migration supplies the guard function, read from the manifest itself. */
function guardMigration(manifest) {
  const found = manifest.objects.find(
    (o) => o.kind === 'function' && o.name === GUARD_FUNCTION
  );
  return found ? found.providedBy : '20260812000000_schema_guard.sql';
}

/**
 * Fetch the live object list. One round trip.
 *
 * Called through PostgREST, the same path the application's own queries take,
 * so a schema cache too stale to see this function fails here rather than
 * later at a user's request.
 *
 * @param {{ rpc: Function }} supabase
 */
async function fetchPresent(supabase, manifest) {
  let result;
  try {
    result = await supabase.rpc(GUARD_FUNCTION);
  } catch (err) {
    throw guardError(
      formatGuardUnavailable(err && err.message ? err.message : String(err), guardMigration(manifest))
    );
  }

  const { data, error } = result || {};
  if (error) {
    throw guardError(
      formatGuardUnavailable(error.message || String(error), guardMigration(manifest))
    );
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.tables)) {
    throw guardError(
      formatGuardUnavailable('returned no object list', guardMigration(manifest))
    );
  }
  return data;
}

/**
 * Verify the database has everything this build needs, or throw.
 *
 * @param {{ rpc: Function }} supabase
 * @param {{ manifest?: object }} [opts]
 * @returns {Promise<{ surface: string, checked: number, present: object }>}
 */
async function assertSchema(supabase, opts = {}) {
  const manifest = opts.manifest || require('./generated/schemaManifest.json');
  const present = await fetchPresent(supabase, manifest);
  const missing = diffObjects(manifest.objects, present);

  if (missing.length) {
    throw guardError(formatMissing(missing, manifest.surface));
  }

  return { surface: manifest.surface, checked: manifest.objects.length, present };
}

module.exports = {
  GUARD_FUNCTION,
  assertSchema,
  diffObjects,
  formatMissing,
  formatGuardUnavailable,
  guardMigration,
};
