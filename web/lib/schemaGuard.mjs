/**
 * Web mirror of lib/schemaGuard.js.
 *
 * WHY THIS DUPLICATION EXISTS: the Vercel Root Directory is web, so ../lib is
 * never uploaded to the deploy (see the same note in web/lib/channelBind.ts).
 * The build gate, the cold-start check and the health route all run inside the
 * deploy, so the comparison logic has to live inside web/ too.
 *
 * KEEPING IT HONEST: test/webSchemaGuard.test.js runs this implementation and
 * lib/schemaGuard.js against identical inputs and asserts they agree on which
 * objects are missing and on the message text. Change one side and that test
 * fails until you change the other.
 *
 * Plain .mjs, not .ts, on purpose: web/scripts/verify-schema.mjs imports it
 * from bare node during prebuild, where TypeScript type stripping cannot be
 * assumed. The explicit .mjs extension is what keeps node from having to guess
 * the module type, since web/package.json has no "type" field.
 *
 * The manifest is passed in rather than imported here, because webpack and bare
 * node disagree about JSON import attributes. Each caller loads it its own way.
 */

export const GUARD_FUNCTION = 'schema_guard_objects';

/**
 * One entry from a generated manifest.
 * @typedef {{ kind: string, name: string, providedBy: string, requiredBy: string }} RequiredObject
 */

/**
 * @typedef {{ surface: string, objects: RequiredObject[] }} SchemaManifest
 */

/** Where a required object of this kind can legitimately show up. */
const PRESENCE_KEYS = {
  table: ['tables', 'views'],
  view: ['views'],
  function: ['functions'],
  trigger: ['triggers'],
};

/**
 * @param {RequiredObject[]} required
 * @param {Record<string, string[]>} present
 * @returns {RequiredObject[]}
 */
export function diffObjects(required, present) {
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
export function formatMissing(missing, surface) {
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
export function formatGuardUnavailable(reason, providedBy) {
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

/** Which migration supplies the guard function, read from the manifest itself. */
export function guardMigration(manifest) {
  const found = manifest.objects.find(
    (o) => o.kind === 'function' && o.name === GUARD_FUNCTION
  );
  return found ? found.providedBy : '20260812000000_schema_guard.sql';
}

/**
 * Check the live schema against a manifest. One round trip.
 *
 * Returns a result rather than throwing: the build gate turns a failure into a
 * non-zero exit, while the cold-start hook only logs. Deciding that here would
 * take the choice away from the caller.
 *
 * @param {{ rpc: Function }} supabase
 * @param {SchemaManifest} manifest
 * @returns {Promise<{ ok: boolean, surface: string, checked: number, missing: RequiredObject[], message: string|null }>}
 */
export async function checkSchema(supabase, manifest) {
  const base = { surface: manifest.surface, checked: manifest.objects.length };

  let result;
  try {
    result = await supabase.rpc(GUARD_FUNCTION);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    return {
      ...base,
      ok: false,
      missing: [],
      message: formatGuardUnavailable(reason, guardMigration(manifest)),
    };
  }

  const { data, error } = result || {};
  if (error || !data || typeof data !== 'object' || !Array.isArray(data.tables)) {
    const reason = error ? error.message || String(error) : 'returned no object list';
    return {
      ...base,
      ok: false,
      missing: [],
      message: formatGuardUnavailable(reason, guardMigration(manifest)),
    };
  }

  const missing = diffObjects(manifest.objects, data);
  return {
    ...base,
    ok: missing.length === 0,
    missing,
    message: missing.length ? formatMissing(missing, manifest.surface) : null,
  };
}
