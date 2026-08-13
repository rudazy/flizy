/**
 * Build gate: refuse to build the site if the database is missing an object
 * this build depends on.
 *
 * This is the real guard on the web side. Vercel is serverless, so there is no
 * long lived boot to hang a startup check on, but a failing build never
 * promotes: the previous deployment keeps serving and no user ever reaches the
 * broken flow. That is strictly better than failing at request time.
 *
 * Everything it needs lives inside web/, because the Vercel Root Directory is
 * web and ../lib is not uploaded. The object list is the manifest committed at
 * web/lib/generated/schemaManifest.json, which is derived from source by
 * scripts/generate-schema-manifest.js and pinned by a test in the root suite.
 *
 * No bypass. Missing credentials, an unreachable database and a missing object
 * all fail the build.
 */

import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';

import { checkSchema } from '../lib/schemaGuard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const MANIFEST = path.join(WEB_ROOT, 'lib', 'generated', 'schemaManifest.json');

// Same order and precedence as web/lib/supabase.ts, so the gate always checks
// the database the application itself would talk to. See the comment there for
// why override:true matters and why .env.local is loaded last. On Vercel all
// three are no-ops and the platform supplies process.env.
loadEnv({ path: path.join(WEB_ROOT, '..', '.env') });
loadEnv({ path: path.join(WEB_ROOT, '.env'), override: true });
loadEnv({ path: path.join(WEB_ROOT, '.env.local'), override: true });

/**
 * Set a failing exit code and let node wind down on its own.
 *
 * Calling process.exit() here instead trips a libuv assertion on Windows
 * (UV_HANDLE_CLOSING in async.c) because the supabase client's fetch handles
 * are still open, which replaces a readable message with a crash dump.
 */
function fail(message) {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return fail(
      'SCHEMA GUARD: SUPABASE_URL and SUPABASE_KEY are required to build.\n\n' +
        '  The build verifies that the database has every object this code\n' +
        '  depends on. Without credentials it cannot, and a build that skips\n' +
        '  the check is the failure mode this guard exists to prevent.'
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (err) {
    return fail(
      `SCHEMA GUARD: cannot read ${path.relative(WEB_ROOT, MANIFEST)}.\n\n` +
        `  ${err.message}\n\n` +
        '  Run: node scripts/generate-schema-manifest.js  (from the repo root)'
    );
  }

  const supabase = createClient(url, key);
  const started = Date.now();
  const result = await checkSchema(supabase, manifest);
  const elapsed = Date.now() - started;

  if (!result.ok) return fail(result.message);

  console.log(
    `Schema guard: ${result.checked} objects present (${result.surface}), ${elapsed} ms.`
  );
}

main().catch((err) => {
  fail(`SCHEMA GUARD: check failed to run.\n\n  ${err && err.message ? err.message : err}`);
});
