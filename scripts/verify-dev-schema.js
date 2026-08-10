/**
 * Verify the DEV database schema matches what the migration stack should have
 * produced.
 *
 * A fresh database plus a stack of migrations is exactly where a missed file or
 * an out-of-order apply leaves a subtly wrong schema, and a migration run that
 * printed no errors is not evidence that it was complete. This introspects the
 * live database and checks it object by object.
 *
 * Reads .env.dev only, and enforces the same dev guard as run-dev-migrations.js:
 * it will not connect to a project that is not declared dev in two places.
 *
 * Usage (Windows CMD):
 *   node scripts\verify-dev-schema.js
 *   node scripts\verify-dev-schema.js --dump    (full column/index listing)
 *
 * Exit code 0 = schema matches. 1 = gaps found (listed table by table).
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.dev');
const PLACEHOLDER = /^(your_|0xyour_|fresh_dev_only_|change-this)|^$/i;

const dump = process.argv.includes('--dump');

// ---------------------------------------------------------------------------
// Expected end state after all 28 migrations.
//
// Derived from the migration files, including the renames: whatsapp_identities
// is renamed to channel_identities by 20260725100000 and then re-created as a
// backward-compatible view, so it must end up a VIEW and not a table.
// ---------------------------------------------------------------------------

const EXPECTED_TABLES = [
  'account_emails',
  'accounts',
  'channel_identities',
  'claims',
  'contacts',
  'email_verifications',
  'identity_bind_attempts',
  'identity_events',
  'link_code_attempts',
  'link_codes',
  'notifications',
  'oauth_callback_attempts',
  'payment_requests',
  'sessions',
  'transfers',
  'trusted_addresses',
  'users',
  'web_sessions',
];

// Both must be security_invoker so they cannot be used to read around the RLS
// of the tables underneath them.
const EXPECTED_VIEWS = ['channel_identity_phone_conflicts', 'whatsapp_identities'];

const EXPECTED_FUNCTIONS = [
  'channel_identities_enforce_one_phone',
  'credit_user_balance',
  'debit_user_balance',
  'identity_events_append_only',
  'set_updated_at',
];

const EXPECTED_TRIGGERS = [
  'accounts_set_updated_at',
  'channel_identities_one_phone',
  'contacts_set_updated_at',
  'identity_events_no_update',
  'trusted_addresses_set_updated_at',
  'users_set_updated_at',
];

// Index names the migrations declare. whatsapp_identities_* survive the table
// rename: renaming a table does not rename its indexes, and no migration drops
// them.
const EXPECTED_INDEXES = [
  'account_emails_account_idx',
  'account_emails_email_unique',
  'accounts_agent_wallet_idx',
  'accounts_email_unique',
  'accounts_username_lower_uidx',
  'channel_identities_account_idx',
  'channel_identities_account_platform_idx',
  'channel_identities_channel_external_idx',
  'channel_identities_phone_idx',
  'claims_from_account_status_idx',
  'claims_from_wa_sender_idx',
  'claims_status_idx',
  'claims_to_email_status_idx',
  'claims_to_platform_status_idx',
  'claims_to_wa_hint_status_idx',
  'contacts_owner_phone_idx',
  'contacts_user_id_idx',
  'email_verifications_account_idx',
  'email_verifications_email_open_idx',
  'identity_bind_attempts_locked_idx',
  'identity_events_account_idx',
  'identity_events_identity_idx',
  'link_code_attempts_locked_idx',
  'link_codes_account_idx',
  'link_codes_expires_idx',
  'notifications_account_idx',
  'notifications_pending_idx',
  'oauth_callback_attempts_locked_idx',
  'payment_requests_from_wa_status_idx',
  'payment_requests_requester_status_idx',
  'payment_requests_status_idx',
  'sessions_account_channel_external_idx',
  'sessions_expires_idx',
  'transfers_account_created_idx',
  'transfers_phone_created_idx',
  'transfers_tx_hash_idx',
  'trusted_addresses_account_idx',
  'users_account_id_idx',
  'users_phone_idx',
  'users_wallet_address_idx',
  'web_sessions_account_idx',
  'web_sessions_expires_idx',
  'web_sessions_token_hash_idx',
  'whatsapp_identities_account_idx',
  'whatsapp_identities_phone_idx',
];

// Tables the migrations explicitly enable RLS on.
const EXPECTED_RLS_ON = [
  'accounts',
  'channel_identities',
  'claims',
  'contacts',
  'identity_bind_attempts',
  'identity_events',
  'link_code_attempts',
  'link_codes',
  'notifications',
  'oauth_callback_attempts',
  'payment_requests',
  'sessions',
  'transfers',
  'trusted_addresses',
  'users',
  'web_sessions',
];

// No migration enables RLS on these two. Recorded here so the verifier reports
// a known, pre-existing gap rather than silently passing it, and so it does not
// read as a dev-only mistake.
const KNOWN_RLS_GAPS = ['account_emails', 'email_verifications'];

const problems = [];
const notes = [];

function diff(label, expected, actual) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((x) => !actualSet.has(x));
  const extra = actual.filter((x) => !expectedSet.has(x));
  if (missing.length) problems.push(`${label}: MISSING -> ${missing.join(', ')}`);
  if (extra.length) notes.push(`${label}: extra (not declared by migrations) -> ${extra.join(', ')}`);
  console.log(
    `  ${label.padEnd(12)} expected ${String(expected.length).padStart(3)}  ` +
      `present ${String(expected.length - missing.length).padStart(3)}  ` +
      `missing ${String(missing.length).padStart(3)}  extra ${extra.length}`
  );
  return missing;
}

function loadDevEnv() {
  if (!fs.existsSync(ENV_FILE)) {
    console.error(`\nABORTED: .env.dev not found at ${ENV_FILE}\n`);
    process.exit(1);
  }
  const env = dotenv.parse(fs.readFileSync(ENV_FILE));
  const url = (env.SUPABASE_URL || '').trim();
  const declaredRef = (env.DEV_SUPABASE_REF || '').trim();
  const password = env.SUPABASE_DB_PASSWORD || '';

  for (const [k, v] of [
    ['DEV_SUPABASE_REF', declaredRef],
    ['SUPABASE_URL', url],
    ['SUPABASE_DB_PASSWORD', password],
  ]) {
    if (PLACEHOLDER.test(v)) {
      console.error(`\nABORTED: ${k} is empty or still a placeholder in .env.dev\n`);
      process.exit(1);
    }
  }

  const m = url.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  if (!m) {
    console.error(`\nABORTED: SUPABASE_URL is not a Supabase project URL: ${url}\n`);
    process.exit(1);
  }
  if (m[1] !== declaredRef) {
    console.error(
      `\nABORTED: dev guard tripped. SUPABASE_URL points at ${m[1]}, ` +
        `DEV_SUPABASE_REF declares ${declaredRef}.\n`
    );
    process.exit(1);
  }
  return { ref: m[1], password };
}

async function main() {
  const { ref, password } = loadDevEnv();
  const client = new Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    user: 'postgres',
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log(`\nVerifying schema on dev project ${ref}\n`);
  console.log('Object counts');

  const q = (sql) => client.query(sql).then((r) => r.rows);

  // --- tables, views, functions, triggers, indexes -------------------------
  const tables = (
    await q(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`
    )
  ).map((r) => r.tablename);
  diff('tables', EXPECTED_TABLES, tables);

  const views = (
    await q(`select viewname from pg_views where schemaname = 'public' order by viewname`)
  ).map((r) => r.viewname);
  diff('views', EXPECTED_VIEWS, views);

  const functions = (
    await q(
      `select p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' order by p.proname`
    )
  ).map((r) => r.proname);
  diff('functions', EXPECTED_FUNCTIONS, functions);

  const triggers = (
    await q(
      `select t.tgname from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
       order by t.tgname`
    )
  ).map((r) => r.tgname);
  diff('triggers', EXPECTED_TRIGGERS, triggers);

  const indexRows = await q(
    `select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname`
  );
  // Primary-key and unique-constraint indexes are named by the constraint, not
  // declared as create index, so they are not part of the declared list.
  const declaredish = indexRows
    .map((r) => r.indexname)
    .filter((n) => !/_pkey$/.test(n) && !/_key$/.test(n));
  diff('indexes', EXPECTED_INDEXES, declaredish);

  // --- RLS ------------------------------------------------------------------
  console.log('\nRow level security');
  const rls = await q(
    `select c.relname, c.relrowsecurity
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname`
  );
  const rlsOn = rls.filter((r) => r.relrowsecurity).map((r) => r.relname);
  const rlsOff = rls.filter((r) => !r.relrowsecurity).map((r) => r.relname);

  const rlsMissing = EXPECTED_RLS_ON.filter((t) => !rlsOn.includes(t));
  if (rlsMissing.length) {
    problems.push(`RLS not enabled where migrations enable it -> ${rlsMissing.join(', ')}`);
  }
  console.log(`  enabled  (${rlsOn.length}): ${rlsOn.join(', ') || 'none'}`);
  console.log(`  disabled (${rlsOff.length}): ${rlsOff.join(', ') || 'none'}`);

  const unexpectedOff = rlsOff.filter(
    (t) => !KNOWN_RLS_GAPS.includes(t) && EXPECTED_TABLES.includes(t)
  );
  if (unexpectedOff.length) {
    problems.push(`RLS off on unexpected tables -> ${unexpectedOff.join(', ')}`);
  }
  const gapsPresent = KNOWN_RLS_GAPS.filter((t) => rlsOff.includes(t));
  if (gapsPresent.length) {
    notes.push(
      `RLS off on ${gapsPresent.join(', ')} - matches the migrations, which never ` +
        `enable it on these two. Pre-existing, also true in production. Worth closing separately.`
    );
  }

  const policies = await q(
    `select tablename, policyname from pg_policies where schemaname = 'public'`
  );
  console.log(`  policies: ${policies.length} (0 expected: service_role bypasses RLS)`);
  if (policies.length) {
    notes.push(`policies present: ${policies.map((p) => p.tablename + '.' + p.policyname).join(', ')}`);
  }

  // --- targeted checks the brief calls out ---------------------------------
  console.log('\nTargeted checks');

  const partial = indexRows.find((r) => r.indexname === 'channel_identities_account_platform_idx');
  if (!partial) {
    problems.push('one-per-channel index channel_identities_account_platform_idx is absent');
    console.log('  one-per-channel index          MISSING');
  } else {
    const isUnique = /create unique index/i.test(partial.indexdef);
    const isPartial = /where /i.test(partial.indexdef);
    const rightPredicate = /'x'/.test(partial.indexdef) && /'github'/.test(partial.indexdef) && /'discord'/.test(partial.indexdef);
    const ok = isUnique && isPartial && rightPredicate;
    console.log(`  one-per-channel index          ${ok ? 'ok (unique, partial)' : 'WRONG SHAPE'}`);
    if (!ok) {
      problems.push(
        `channel_identities_account_platform_idx wrong shape: unique=${isUnique} ` +
          `partial=${isPartial} predicate=${rightPredicate}. def: ${partial.indexdef}`
      );
    }
  }

  const appendOnly = await q(
    `select t.tgname, t.tgtype from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     where c.relname = 'identity_events' and t.tgname = 'identity_events_no_update'
       and not t.tgisinternal`
  );
  if (!appendOnly.length) {
    problems.push('append-only trigger identity_events_no_update is absent on identity_events');
    console.log('  identity_events append-only    MISSING');
  } else {
    // tgtype bits: 1=row, 2=before, 16=update, 8=delete
    const t = appendOnly[0].tgtype;
    const ok = (t & 1) && (t & 2) && (t & 16) && (t & 8);
    console.log(`  identity_events append-only    ${ok ? 'ok (before update or delete, row)' : 'WRONG TIMING'}`);
    if (!ok) problems.push(`identity_events_no_update wrong timing/events, tgtype=${t}`);
  }

  const invoker = await q(
    `select c.relname, c.reloptions from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v' order by c.relname`
  );
  for (const v of invoker) {
    const opts = v.reloptions || [];
    const ok = opts.some((o) => /^security_invoker=(true|on)$/i.test(o));
    console.log(`  view ${v.relname.padEnd(34)} ${ok ? 'security_invoker=true' : 'NOT security_invoker'}`);
    if (!ok) problems.push(`view ${v.relname} is not security_invoker=true (reloptions: ${opts.join(',') || 'none'})`);
  }

  // --- per-table column/constraint detail ----------------------------------
  console.log('\nPer-table detail');
  for (const t of EXPECTED_TABLES) {
    if (!tables.includes(t)) {
      console.log(`  ${t.padEnd(26)} TABLE MISSING`);
      continue;
    }
    const cols = await q(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = '${t}' order by ordinal_position`
    );
    const cons = await q(
      `select conname, contype from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = '${t}' order by conname`
    );
    const idx = indexRows.filter((r) => new RegExp(`\\bON public\\.${t}\\b`, 'i').test(r.indexdef));
    const byType = (ch) => cons.filter((c) => c.contype === ch).length;
    console.log(
      `  ${t.padEnd(26)} cols ${String(cols.length).padStart(3)}  ` +
        `pk ${byType('p')}  fk ${byType('f')}  uniq ${byType('u')}  check ${byType('c')}  idx ${idx.length}`
    );
    if (dump) {
      cols.forEach((c) =>
        console.log(`      - ${c.column_name} ${c.data_type}${c.is_nullable === 'NO' ? ' not null' : ''}`)
      );
      idx.forEach((i) => console.log(`      * ${i.indexname}`));
    }
  }

  await client.end();

  // --- verdict --------------------------------------------------------------
  console.log('\n' + '='.repeat(72));
  if (notes.length) {
    console.log('\nNotes (not failures):');
    notes.forEach((n) => console.log(`  - ${n}`));
  }
  if (problems.length) {
    console.log(`\nSCHEMA GAPS FOUND (${problems.length}):`);
    problems.forEach((p) => console.log(`  - ${p}`));
    console.log('');
    process.exit(1);
  }
  console.log('\nSchema matches the migration stack. No gaps found.\n');
}

main().catch((e) => {
  console.error(`\nVerification failed to run: ${e.message}`);
  process.exit(1);
});
