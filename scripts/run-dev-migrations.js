/**
 * Apply the full migration stack to the DEV Supabase database, in order.
 *
 * Dev-only by construction. This script never reads process.env for connection
 * details: it parses .env.dev directly and uses only those values. An ambient
 * SUPABASE_URL in the shell, or a production .env on disk, therefore cannot
 * influence where this connects. That is the whole point of the file.
 *
 * The guard requires the target to be declared as dev in TWO independent
 * places, and to agree:
 *   - SUPABASE_URL       the project the connection is built from
 *   - DEV_SUPABASE_REF   an explicit statement of which ref is the dev one
 * Pasting a production URL into SUPABASE_URL aborts, because the ref derived
 * from it will not match DEV_SUPABASE_REF. One slip is not enough to reach a
 * production database; it takes two deliberate, agreeing edits.
 *
 * Usage (Windows CMD):
 *   node scripts\run-dev-migrations.js --dry-run
 *   node scripts\run-dev-migrations.js --confirm
 *   node scripts\run-dev-migrations.js --confirm --from 20260725100000_channel_identities.sql
 *   node scripts\run-dev-migrations.js --confirm --only 20260802160000_identity_events.sql
 *
 * Migrations are applied one named file at a time, in filename (timestamp)
 * order, each in its own transaction, stopping on the first failure. It does
 * not use `supabase db push`: the production project has migration-history
 * drift and push would try to reconcile it.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.dev');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

// Values still carrying their template text. Treated as "not filled in" so the
// script fails with a clear message instead of a confusing connection error.
const PLACEHOLDER = /^(your_|0xyour_|fresh_dev_only_|change-this)|^$/i;

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

function fail(message) {
  console.error(`\nABORTED: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load and validate the dev target
// ---------------------------------------------------------------------------

function loadDevEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    fail(
      `.env.dev not found at ${ENV_FILE}\n` +
        'Copy .env.dev.example to .env.dev and fill in the dev Supabase values.'
    );
  }

  // Parsed, not injected into process.env, so nothing here can leak into other
  // libraries that read process.env later in the same process.
  const env = dotenv.parse(fs.readFileSync(ENV_FILE));

  const url = (env.SUPABASE_URL || '').trim();
  const declaredRef = (env.DEV_SUPABASE_REF || '').trim();
  const password = env.SUPABASE_DB_PASSWORD || '';

  if (PLACEHOLDER.test(declaredRef)) {
    fail('DEV_SUPABASE_REF is empty or still a placeholder in .env.dev.');
  }
  if (PLACEHOLDER.test(url)) {
    fail('SUPABASE_URL is empty or still a placeholder in .env.dev.');
  }
  if (PLACEHOLDER.test(password)) {
    fail('SUPABASE_DB_PASSWORD is empty or still a placeholder in .env.dev.');
  }

  const match = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  if (!match) {
    fail(`SUPABASE_URL is not a Supabase project URL: ${url}`);
  }
  const derivedRef = match[1];

  if (derivedRef !== declaredRef) {
    fail(
      'dev guard tripped: SUPABASE_URL and DEV_SUPABASE_REF disagree.\n' +
        `  SUPABASE_URL points at project: ${derivedRef}\n` +
        `  DEV_SUPABASE_REF declares:      ${declaredRef}\n` +
        'Refusing to connect. If the URL is correct, this is the check telling\n' +
        'you the project you are about to migrate is not the one you called dev.'
    );
  }

  // Optional extra belt: explicit refs that must never be touched.
  const blocked = (env.BLOCKED_SUPABASE_REFS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (blocked.includes(derivedRef)) {
    fail(`project ref ${derivedRef} is in BLOCKED_SUPABASE_REFS. Refusing.`);
  }

  return { ref: derivedRef, password };
}

// ---------------------------------------------------------------------------
// Migration list
// ---------------------------------------------------------------------------

function migrationFiles() {
  const all = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // timestamp prefixes are fixed width, so lexical order is chronological

  const malformed = all.filter((f) => !/^\d{14}_.+\.sql$/.test(f));
  if (malformed.length) {
    fail(`migration filenames do not carry a 14-digit timestamp: ${malformed.join(', ')}`);
  }

  const only = flagValue('--only');
  if (only) {
    if (!all.includes(only)) fail(`--only ${only} is not in ${MIGRATIONS_DIR}`);
    return [only];
  }

  const from = flagValue('--from');
  if (from) {
    const i = all.indexOf(from);
    if (i === -1) fail(`--from ${from} is not in ${MIGRATIONS_DIR}`);
    return all.slice(i);
  }

  return all;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function main() {
  const files = migrationFiles();
  const dryRun = hasFlag('--dry-run');

  // Resolve the target even on a dry run: a dry run that skips the guard would
  // report an order that a real run might not be allowed to apply.
  const { ref, password } = loadDevEnv();
  const host = `db.${ref}.supabase.co`;

  console.log('');
  console.log('  target host : ' + host);
  console.log('  project ref : ' + ref + '  (matches DEV_SUPABASE_REF)');
  console.log('  database    : postgres');
  console.log('  migrations  : ' + files.length + ' file(s), in timestamp order');
  console.log('');
  files.forEach((f, i) => console.log(`    ${String(i + 1).padStart(2, ' ')}. ${f}`));
  console.log('');

  if (dryRun) {
    console.log('Dry run: nothing was executed.');
    return;
  }

  if (!hasFlag('--confirm')) {
    fail('refusing to run without --confirm. Review the target above, then re-run with --confirm.');
  }

  const client = new Client({
    host,
    port: 5432,
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  // Confirm at the server, not just from the connection string, that this is
  // the database we think it is.
  const who = await client.query(
    'select current_database() as db, inet_server_addr()::text as addr'
  );
  console.log(`Connected: database=${who.rows[0].db} server=${who.rows[0].addr}\n`);

  const applied = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    process.stdout.write(`  applying ${file} ... `);
    try {
      // Each file is atomic on its own: a file that fails part way leaves no
      // half-applied schema behind, so a fixed file can simply be re-run.
      await client.query('begin');
      await client.query(sql);
      await client.query('commit');
      applied.push(file);
      console.log('ok');
    } catch (err) {
      try {
        await client.query('rollback');
      } catch (_) {
        // connection already unusable; the original error is the useful one
      }
      await client.end();
      console.log('FAILED');
      console.error('\n--------------------------------------------------------');
      console.error(`FAILED FILE : ${file}`);
      console.error(`ERROR       : ${err.message}`);
      if (err.detail) console.error(`DETAIL      : ${err.detail}`);
      if (err.hint) console.error(`HINT        : ${err.hint}`);
      if (err.position) console.error(`POSITION    : ${err.position}`);
      console.error(`\nApplied cleanly before the failure (${applied.length}):`);
      applied.forEach((f) => console.error(`  ${f}`));
      console.error(`\nThis file was rolled back. Not applied (${files.length - applied.length}):`);
      files.slice(applied.length).forEach((f) => console.error(`  ${f}`));
      console.error(
        `\nAfter fixing, resume with:\n  node scripts\\run-dev-migrations.js --confirm --from ${file}`
      );
      console.error('--------------------------------------------------------\n');
      process.exit(1);
    }
  }

  await client.end();
  console.log(`\nAll ${applied.length} migration(s) applied cleanly to ${ref}.`);
  console.log('Next: node scripts\\verify-dev-schema.js');
}

main().catch((e) => {
  console.error(`\nUnexpected failure: ${e.message}`);
  process.exit(1);
});
