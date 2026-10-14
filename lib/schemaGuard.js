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
 *
 * Exposure is a second, separate rule: nothing in public may be reachable by
 * anon, authenticated or PUBLIC (see diffExposure). It is a rule, not a mirror
 * of what the migrations declare, so a migration that forgets RLS or a revoke
 * fails it. The bot only reports exposure (assertSchema returns it, the caller
 * logs it and sends it to Sentry); stopping a bot does not close a hole in the
 * database. The web build gate fails on it.
 */

const GUARD_FUNCTION = 'schema_guard_objects';

/** Sentry tag value every exposure report carries, under the tag key "alert". */
const EXPOSURE_ALERT_TAG = 'schema_exposure';

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

/** Where a required object of this kind can legitimately show up. */
const PRESENCE_KEYS = {
  table: ['tables', 'views'],
  view: ['views'],
  function: ['functions'],
  trigger: ['triggers'],
  check: ['checks'],
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
 * @returns {{ findings: object[], allowlisted: object[] } | null}
 */
function diffExposure(present, allowlist) {
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
function formatExposure(findings, surface) {
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
function formatAllowlisted(allowlisted) {
  const lines = [`Schema exposure allowlist: ${allowlisted.length} accepted.`];
  for (const finding of allowlisted) {
    lines.push(`  ${findingLabel(finding)}`);
    lines.push(`    ${finding.detail}`);
    lines.push(`    reason: ${finding.reason}`);
  }
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

/**
 * The exposure half of a check, ready for a caller to act on.
 * message is null when nothing is exposed; unavailable is true when the guard
 * function is too old to say.
 */
function exposureResult(present, manifest, allowlist) {
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
  // A guard function from before check constraints were tracked would make
  // every required check look missing. Name the one migration that fixes that.
  if (manifest.objects.some((o) => o.kind === 'check') && !Array.isArray(data.checks)) {
    throw guardError(
      formatGuardUnavailable('is an older version that does not report check constraints', guardMigration(manifest))
    );
  }
  return data;
}

/**
 * Verify the database has everything this build needs, or throw. Exposure is
 * returned, never thrown: see the header.
 *
 * @param {{ rpc: Function }} supabase
 * @param {{ manifest?: object, allowlist?: object }} [opts]
 * @returns {Promise<{ surface: string, checked: number, present: object, exposure: object }>}
 */
async function assertSchema(supabase, opts = {}) {
  const manifest = opts.manifest || require('./generated/schemaManifest.json');
  const allowlist = opts.allowlist || require('./schemaExposureAllowlist.json');
  const present = await fetchPresent(supabase, manifest);
  const missing = diffObjects(manifest.objects, present);

  if (missing.length) {
    throw guardError(formatMissing(missing, manifest.surface));
  }

  return {
    surface: manifest.surface,
    checked: manifest.objects.length,
    present,
    exposure: exposureResult(present, manifest, allowlist),
  };
}

/**
 * Say what assertSchema found about exposure: loudly to the log, and to the
 * reporter (Sentry, tagged EXPOSURE_ALERT_TAG) when anything is wrong.
 * Dependencies are passed in so this stays testable and free of side effects
 * on import.
 *
 * @param {{ message: string|null, allowlisted: object[] }} exposure
 * @param {{ log: Function, warn: Function, report: Function }} deps
 * @returns {boolean} whether anything was reported
 */
function reportExposure(exposure, { log, warn, report }) {
  if (exposure.allowlisted.length) log(formatAllowlisted(exposure.allowlisted));
  if (!exposure.message) return false;
  warn(`\n${exposure.message}\n`);
  report(exposure.message);
  return true;
}

module.exports = {
  GUARD_FUNCTION,
  EXPOSURE_ALERT_TAG,
  assertSchema,
  diffObjects,
  diffExposure,
  exposureResult,
  formatMissing,
  formatExposure,
  formatAllowlisted,
  formatGuardUnavailable,
  guardMigration,
  reportExposure,
};
