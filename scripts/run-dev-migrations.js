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
 * The guard itself lives in scripts/devDbTarget.js so this file and
 * verify-dev-schema.js cannot drift apart on what counts as dev.
 *
 * Connection route: direct to db.<ref>.supabase.co by default. Where that host
 * resolves IPv6-only and times out, set SUPABASE_DB_POOLER_HOST in .env.dev to
 * use the IPv4-reachable pooler instead. The dry run prints which route it will
 * take. The pooler does not widen the guard: the tenant is pinned by the
 * postgres.<ref> username, built from the ref that already passed the check.
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
const { Client } = require('pg');

const { loadDevTarget, describeTarget } = require('./devDbTarget');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.dev');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

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
  let target;
  try {
    target = loadDevTarget(ENV_FILE);
  } catch (err) {
    fail(err.message);
  }

  console.log('');
  describeTarget(target).forEach((line) => console.log(line));
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

  const client = new Client(target.clientConfig);

  try {
    await client.connect();
  } catch (err) {
    const unreachable = ['ETIMEDOUT', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'];
    if (err && unreachable.includes(err.code)) {
      fail(
        `cannot reach ${target.host}:${target.port} (${err.code}).\n` +
          (target.mode === 'direct'
            ? '  The direct host is not reachable from every network: it can resolve\n' +
              '  IPv6-only, and on newer Supabase projects it may not exist at all.\n' +
              '  Set SUPABASE_DB_POOLER_HOST in .env.dev to use the IPv4 pooler, e.g.\n' +
              '    SUPABASE_DB_POOLER_HOST=aws-0-eu-west-1.pooler.supabase.com\n' +
              '  then re-run. Nothing was applied.'
            : '  Check the pooler hostname and region. Nothing was applied.')
      );
    }
    fail(`could not connect to ${target.host}:${target.port}: ${err.message}`);
  }

  // Confirm at the server, not just from the connection string, that this is
  // the database we think it is. inet_server_addr() is null through the pooler,
  // which is expected rather than a problem, so it is reported as unavailable.
  const who = await client.query(
    'select current_database() as db, inet_server_addr()::text as addr'
  );
  const addr = who.rows[0].addr || 'n/a via pooler';
  console.log(`Connected: database=${who.rows[0].db} server=${addr} route=${target.mode}\n`);

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
  console.log(`\nAll ${applied.length} migration(s) applied cleanly to ${target.ref}.`);
  console.log('Next: node scripts\\verify-dev-schema.js');
}

main().catch((e) => {
  console.error(`\nUnexpected failure: ${e.message}`);
  process.exit(1);
});
