/**
 * Drive the tasks feature end to end against the DEV database.
 *
 * The committed unit suite cannot prove the part that matters most here. The
 * fake in test/helpers/fakeSupabase.js has no triggers, no CHECK constraints and
 * no unique indexes, so the submission window, one-entry-per-person and
 * one-entry-per-post rules are invisible to it. Those live in
 * supabase/migrations/20260925010000_tasks.sql and can only be proven by running
 * against a real Postgres.
 *
 * So this exists alongside the tests rather than instead of them: the tests pin
 * the decisions the application makes, and this pins the ones the database
 * makes, by driving web/lib/tasks.ts exactly as the routes do.
 *
 * SAFETY. The target is resolved by scripts/devDbTarget.js, the same guard
 * run-dev-migrations.js uses: only .env.dev is read, and the ref must be
 * declared dev in two independent places before anything connects. The REST
 * credentials come from web/.env.local and are refused unless they point at
 * that same ref, so a production .env on disk or an ambient SUPABASE_URL cannot
 * steer this. It writes test rows and deletes them again.
 *
 * Usage (Windows CMD):
 *   node scripts\verify-tasks-dev.mjs
 *
 * Exit code 0 = every check passed. 1 = something is wrong, listed above.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const dotenv = require('dotenv');
const { loadDevTarget } = require('./devDbTarget.js');

// 1. The dev guard decides which project is safe. Only .env.dev is read.
const target = loadDevTarget(path.join(ROOT, '.env.dev'));
const devRef = target.ref;

// 2. The REST credentials must point at that same project.
const webEnvPath = path.join(ROOT, 'web', '.env.local');
if (!fs.existsSync(webEnvPath)) {
  console.error('web/.env.local is missing; it supplies the service key this uses.');
  process.exit(1);
}
const webEnv = dotenv.parse(fs.readFileSync(webEnvPath, 'utf8'));
const webRef = String(webEnv.SUPABASE_URL || '').match(/^https:\/\/([a-z0-9]+)\.supabase\./i)?.[1];
if (!webRef || webRef !== devRef) {
  console.error(
    `refusing: web/.env.local points at ${webRef || 'nothing'}, but the declared dev ref is ${devRef}`
  );
  process.exit(1);
}
// getSupabase() falls back to SUPABASE_SERVICE_ROLE_KEY when SUPABASE_KEY is
// empty, and that fallback would come from whatever .env the import loaded.
if (!String(webEnv.SUPABASE_KEY || '').trim()) {
  console.error('refusing: web/.env.local has no SUPABASE_KEY.');
  process.exit(1);
}

// 3. Import first, THEN set the env.
//
// web/lib/supabase.ts calls dotenv at import time with override:true against
// paths relative to process.cwd(). Run from the repo root that is the
// production .env, so anything set before the import is replaced by it. Setting
// it afterwards wins because getSupabase() reads process.env lazily and caches
// the client on first use, and nothing here has called it yet.
const T = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'tasks.ts')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'web', 'lib', 'supabase.ts')).href);

process.env.SUPABASE_URL = webEnv.SUPABASE_URL;
process.env.SUPABASE_KEY = webEnv.SUPABASE_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.SITE_URL = 'https://flizy.test';

// 4. Before any write, confirm the client the tasks module will use is the dev
// one. getSupabase() is the same module instance tasks.ts imports, and this is
// its first call, so the client it builds and caches here is the one every
// T.* call below receives.
const trimSlash = (u) => String(u || '').replace(/\/+$/, '');
const moduleUrl = trimSlash(S.getSupabase().supabaseUrl);
if (!moduleUrl || moduleUrl !== trimSlash(webEnv.SUPABASE_URL)) {
  console.error(`refusing: the tasks module's client points at ${moduleUrl || 'nothing'}, not the dev ref ${devRef}`);
  process.exit(1);
}
const { createClient } = require('@supabase/supabase-js');
const db = createClient(webEnv.SUPABASE_URL, webEnv.SUPABASE_KEY, {
  auth: { persistSession: false },
});

console.log(`target: ${devRef} (dev)\n`);

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) {
    console.log(`  ok    ${label}`);
    pass += 1;
  } else {
    console.log(`  FAIL  ${label} ${extra}`);
    fail += 1;
  }
};
const refuses = async (label, fn, match) => {
  try {
    await fn();
    console.log(`  FAIL  ${label} -> allowed`);
    fail += 1;
  } catch (e) {
    const m = String(e.message || '');
    if (!match || m.toLowerCase().includes(match.toLowerCase())) {
      console.log(`  ok    ${label}`);
      pass += 1;
    } else {
      console.log(`  FAIL  ${label} -> wrong error: ${m}`);
      fail += 1;
    }
  }
};

const stamp = Date.now();
const made = [];
async function account(tag) {
  const { data, error } = await db
    .from('accounts')
    .insert({
      email: `tasksverify-${tag}-${stamp}@example.invalid`,
      password_hash: 'x',
      username: `tv${tag}${String(stamp).slice(-5)}`,
    })
    .select('id')
    .single();
  if (error) {
    console.error('fixture failed:', error.message);
    process.exit(1);
  }
  made.push(data.id);
  return data.id;
}

const creator = await account('cr');
const alice = await account('al');
const bob = await account('bo');
const future = () => new Date(Date.now() + 3600e3).toISOString();

try {
  console.log('THE DATABASE RULES  (what the unit tests cannot reach)');

  const { ref } = await T.createTask(creator, {
    title: 'Verification task',
    description: 'Created by scripts/verify-tasks-dev.mjs',
    rewardKind: 'wl',
    rewardDisplay: '10 WL spots',
    winnersCount: 2,
    endsAt: future(),
    requirements: [{ kind: 'x_post', label: 'Submit the post URL' }],
  });
  ok('the sequence issues a task ref', Number.isInteger(ref), `(got ${ref})`);

  const POST = 'https://x.com/alice/status/1234567890';
  const first = await T.submitToTask(alice, ref, { url: POST });
  ok('an entry is accepted', first.submissionRef === 1);

  await refuses(
    'the same account cannot enter twice (unique index)',
    () => T.submitToTask(alice, ref, { url: 'https://x.com/alice/status/9999999999' }),
    'already entered'
  );
  await refuses(
    'the same post cannot be entered by somebody else (unique index)',
    () => T.submitToTask(bob, ref, { url: POST }),
    'already been submitted'
  );
  await refuses(
    'and not via another spelling of that post',
    () => T.submitToTask(bob, ref, { url: 'https://twitter.com/alice/status/1234567890?s=20' }),
    'already been submitted'
  );

  const { data: row } = await db.from('tasks').select('id').eq('ref', ref).single();
  await db
    .from('tasks')
    .update({ ends_at: new Date(Date.now() - 60e3).toISOString() })
    .eq('id', row.id);

  await refuses(
    'no entry after the deadline (trigger)',
    () => T.submitToTask(bob, ref, { url: 'https://x.com/bob/status/2222222222' }),
    'closed'
  );

  const detail = await T.getTaskByRef(ref, { viewerAccountId: null });
  ok('a closed task reads as under review', detail.state === 'review');
  ok('and still exposes no entries', detail.winners.length === 0 && !('submissions' in detail));
  ok('the entry count comes from task_participant_counts', detail.participants === 1, `(got ${detail.participants})`);

  const { submissions } = await T.listSubmissionsForCreator(creator, ref);
  ok('the creator can now read the entries', submissions.length === 1);

  await T.finalizeWinners(creator, ref, [{ submissionId: submissions[0].id, place: 1 }]);
  const done = await T.getTaskByRef(ref, { viewerAccountId: null });
  ok('winners are public once completed', done.state === 'completed' && done.winners.length === 1);

  await refuses(
    'a completed task cannot be finalised again',
    () => T.finalizeWinners(creator, ref, [{ submissionId: submissions[0].id, place: 2 }]),
    'already finished'
  );

  const cancelled = await T.createTask(creator, {
    title: 'Verification task, withdrawn',
    description: '',
    rewardKind: 'custom',
    rewardDisplay: 'nothing',
    winnersCount: 1,
    endsAt: future(),
    requirements: [{ kind: 'text', label: 'Write something' }],
  });
  await T.cancelTask(creator, cancelled.ref);
  await refuses(
    'no entry to a cancelled task (trigger)',
    () => T.submitToTask(alice, cancelled.ref, { text: 'hello' }),
    'closed'
  );

  // Written straight to the table, past createProject's own check, so only the
  // trigger stands in the way. A row that does land is removed with its owner.
  const aliceName = `tval${String(stamp).slice(-5)}`;
  const { error: clash } = await db
    .from('projects')
    .insert({ owner_account_id: creator, handle: aliceName, name: 'Clash' });
  ok('a project handle cannot be an existing username (trigger)', clash?.code === 'FZ101', `(got ${clash?.code || 'no error'})`);
} finally {
  /*
   * Cleanup is checked, not assumed.
   *
   * An account that has a channel identity cannot be removed, because the
   * cascade tries to update `identity_events`, which is append-only by design.
   * These fixtures have no identities so they do delete, but the error and the
   * row count are both checked so a failed cleanup is reported, not hidden.
   */
  const { data: removed, error: cleanupErr } = await db
    .from('accounts')
    .delete()
    .in('id', made)
    .select('id');

  if (cleanupErr) {
    console.error(`\ncleanup FAILED: ${cleanupErr.message}`);
    console.error(`  ${made.length} fixture account(s) are still on dev. Ids: ${made.join(', ')}`);
    fail += 1;
  } else if ((removed || []).length !== made.length) {
    console.error(
      `\ncleanup INCOMPLETE: removed ${(removed || []).length} of ${made.length} fixture accounts.`
    );
    fail += 1;
  }
}

console.log(`\npassed ${pass}, failed ${fail}`);
process.exit(fail ? 1 : 0);
