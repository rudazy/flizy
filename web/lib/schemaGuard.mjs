/**
 * Web mirror of lib/schemaGuard.js.
 *
 * WHY THIS DUPLICATION EXISTS: the Vercel Root Directory is web, so ../lib is
 * never uploaded to the deploy (see the same note in web/lib/channelBind.ts).
 * The build gate, the cold-start check, the health route and the daily cron
 * check all run inside the deploy, so the comparison logic has to live inside
 * web/ too.
 *
 * KEEPING IT HONEST: test/schemaGuard.test.js runs this implementation and
 * lib/schemaGuard.js against identical inputs and asserts they agree on which
 * objects are missing, on what is exposed and on the message text. It also
 * asserts the two allowlist files are identical. Change one side and that
 * test fails until you change the other.
 *
 * Plain .mjs, not .ts, on purpose: web/scripts/verify-schema.mjs imports it
 * from bare node during prebuild, where TypeScript type stripping cannot be
 * assumed. The explicit .mjs extension is what keeps node from having to guess
 * the module type, since web/package.json has no "type" field.
 *
 * The manifest and the allowlist are passed in rather than imported here,
 * because webpack and bare node disagree about JSON import attributes. Each
 * caller loads them its own way.
 */

export const GUARD_FUNCTION = 'schema_guard_objects';

/** Sentry tag value every exposure report carries, under the tag key "alert". */
export const EXPOSURE_ALERT_TAG = 'schema_exposure';

/** Roles that must reach nothing in public. PUBLIC is the everyone pseudo-role. */
const BROWSER_ROLES = ['anon', 'authenticated', 'PUBLIC'];

/** Finding kinds diffExposure produces, and the only kinds an allowlist may name. */
const EXPOSURE_KINDS = [
  'rls_off',
  'relation_grant',
  'function_execute',
  'definer_search_path',
  'default_acl',
];

/**
 * One entry from a generated manifest.
 * @typedef {{ kind: string, name: string, providedBy: string, requiredBy: string }} RequiredObject
 */

/**
 * @typedef {{ surface: string, objects: RequiredObject[] }} SchemaManifest
 */

/**
 * @typedef {{ kind: string, name: string, grantee: string|null, detail: string, reason?: string }} ExposureFinding
 */

/**
 * @typedef {{ findings: ExposureFinding[], allowlisted: ExposureFinding[], unavailable: boolean, message: string|null }} ExposureResult
 */

/** Where a required object of this kind can legitimately show up. */
const PRESENCE_KEYS = {
  table: ['tables', 'views'],
  view: ['views'],
  function: ['functions'],
  trigger: ['triggers'],
  check: ['checks'],
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

/**
 * Reject an allowlist that is malformed. Every entry needs a known kind, a
 * name and a written reason; an exception nobody can explain is not one.
 * @param {{ entries?: object[] }} allowlist
 */
function validateAllowlist(allowlist) {
  const entries = allowlist && Array.isArray(allowlist.entries) ? allowlist.entries : null;
  if (!entries) {
    throw new Error('schema exposure allowlist: expected an object with an "entries" array');
  }
  entries.forEach((entry, i) => {
    if (!entry || !EXPOSURE_KINDS.includes(entry.kind)) {
      throw new Error(`schema exposure allowlist: entry ${i} has an unknown kind`);
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      throw new Error(`schema exposure allowlist: entry ${i} has no name`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`schema exposure allowlist: entry ${i} (${entry.name}) has no reason`);
    }
  });
  return entries;
}

/**
 * Everything in public that anon, authenticated or PUBLIC can reach, minus
 * what the allowlist accepts. Returns null when the guard function predates
 * the exposure report, so the caller can say that rather than report "clean".
 *
 * @param {Record<string, any>} present schema_guard_objects() payload
 * @param {{ entries: object[] }} allowlist
 * @returns {{ findings: ExposureFinding[], allowlisted: ExposureFinding[] } | null}
 */
export function diffExposure(present, allowlist) {
  const entries = validateAllowlist(allowlist);
  const exposure = present && present.exposure;
  if (!exposure || typeof exposure !== 'object') return null;

  const browser = (grantee) => BROWSER_ROLES.includes(grantee);
  const list = (key) => (Array.isArray(exposure[key]) ? exposure[key] : []);
  const all = [];

  const rls = new Set(present.rls_enabled || []);
  for (const name of present.tables || []) {
    if (!rls.has(name)) {
      all.push({ kind: 'rls_off', name, grantee: null, detail: 'row level security off' });
    }
  }
  for (const g of list('relation_grants')) {
    if (!browser(g.grantee)) continue;
    all.push({
      kind: 'relation_grant',
      name: g.name,
      grantee: g.grantee,
      detail: `${g.type}: ${(g.privileges || []).join(',')}`,
    });
  }
  for (const f of list('function_execute')) {
    if (!browser(f.grantee)) continue;
    all.push({
      kind: 'function_execute',
      name: f.name,
      grantee: f.grantee,
      detail: f.security_definer ? 'EXECUTE, SECURITY DEFINER' : 'EXECUTE',
    });
  }
  for (const f of list('definer_functions')) {
    if (f.search_path) continue;
    all.push({
      kind: 'definer_search_path',
      name: f.name,
      grantee: null,
      detail: 'SECURITY DEFINER with no pinned search_path',
    });
  }
  for (const d of list('default_acl')) {
    if (!browser(d.grantee)) continue;
    all.push({
      kind: 'default_acl',
      name: `${d.role}:${d.schema}:${d.object_type}`,
      grantee: d.grantee,
      detail: `new ${d.object_type} get ${(d.privileges || []).join(',')}`,
    });
  }

  const findings = [];
  const allowlisted = [];
  for (const finding of all) {
    const entry = entries.find(
      (e) =>
        e.kind === finding.kind &&
        e.name === finding.name &&
        (!e.grantee || e.grantee === finding.grantee)
    );
    if (entry) allowlisted.push({ ...finding, reason: entry.reason });
    else findings.push(finding);
  }
  return { findings, allowlisted };
}

function findingLabel(finding) {
  return `${finding.kind} ${finding.name}${finding.grantee ? ` (${finding.grantee})` : ''}`;
}

/** Operator-facing report of what the browser roles can reach. */
export function formatExposure(findings, surface) {
  const lines = [
    `SCHEMA EXPOSURE: ${findings.length} finding${findings.length === 1 ? '' : 's'} ` +
      `in the public schema (${surface}).`,
    '',
  ];
  for (const finding of findings) {
    lines.push(`  ${findingLabel(finding)}`);
    lines.push(`    ${finding.detail}`);
  }
  lines.push('');
  lines.push('anon, authenticated and PUBLIC must reach nothing in public. Fix it with a');
  lines.push('migration: enable RLS, grant service_role what it uses, then revoke from anon,');
  lines.push('authenticated and PUBLIC (20261015140000_lock_public_exposure.sql shows how).');
  lines.push('A deliberate exception goes in schemaExposureAllowlist.json, in both lib/ and');
  lines.push('web/lib/, with a written reason.');
  return lines.join('\n');
}

/** Printed on every check that passes through the allowlist, so it stays visible. */
export function formatAllowlisted(allowlisted) {
  const lines = [`Schema exposure allowlist: ${allowlisted.length} accepted.`];
  for (const finding of allowlisted) {
    lines.push(`  ${findingLabel(finding)}`);
    lines.push(`    ${finding.detail}`);
    lines.push(`    reason: ${finding.reason}`);
  }
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
 * The exposure half of a check, ready for a caller to act on.
 * message is null when nothing is exposed; unavailable is true when the guard
 * function is too old to say.
 *
 * @returns {ExposureResult}
 */
export function exposureResult(present, manifest, allowlist) {
  const diff = diffExposure(present, allowlist);
  if (!diff) {
    return {
      findings: [],
      allowlisted: [],
      unavailable: true,
      message: formatGuardUnavailable(
        'is an older version that does not report exposure',
        guardMigration(manifest)
      ),
    };
  }
  return {
    ...diff,
    unavailable: false,
    message: diff.findings.length ? formatExposure(diff.findings, manifest.surface) : null,
  };
}

/**
 * Check the live schema against a manifest. One round trip.
 *
 * Returns a result rather than throwing: the build gate turns a failure into a
 * non-zero exit, while the cold-start hook and the daily check only report.
 * Deciding that here would take the choice away from the caller.
 *
 * ok covers presence only (every required object exists). exposure is
 * reported separately and is null when presence could not be checked. The
 * public health route answers with ok alone, so it never advertises a hole.
 *
 * @param {{ rpc: Function }} supabase
 * @param {SchemaManifest} manifest
 * @param {{ entries: object[] }} [allowlist] defaults to empty, which fails closed:
 *   an exception the caller forgot to pass is reported, not silently accepted
 * @returns {Promise<{ ok: boolean, surface: string, checked: number, missing: RequiredObject[], message: string|null, exposure: ExposureResult|null }>}
 */
export async function checkSchema(supabase, manifest, allowlist = { entries: [] }) {
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
      exposure: null,
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
      exposure: null,
    };
  }

  // A guard function from before check constraints were tracked would make
  // every required check look missing. Name the one migration that fixes that.
  if (manifest.objects.some((o) => o.kind === 'check') && !Array.isArray(data.checks)) {
    return {
      ...base,
      ok: false,
      missing: [],
      message: formatGuardUnavailable(
        'is an older version that does not report check constraints',
        guardMigration(manifest)
      ),
      exposure: null,
    };
  }

  const exposure = exposureResult(data, manifest, allowlist);
  const missing = diffObjects(manifest.objects, data);
  if (missing.length) {
    return {
      ...base,
      ok: false,
      missing,
      message: formatMissing(missing, manifest.surface),
      exposure,
    };
  }

  return {
    ...base,
    ok: true,
    missing: [],
    message: null,
    exposure,
  };
}
