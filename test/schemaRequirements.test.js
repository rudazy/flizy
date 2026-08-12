/**
 * The derivation behind the startup schema guard.
 *
 * The guard is only worth having if its object list matches reality, so the
 * dangerous failure here is under-detection: a scan that quietly sees fewer
 * dependencies than the code has, leaving a guard that reassures without
 * checking. Two things defend against that.
 *
 * First, the parser and the scanner are pinned against fixtures, including the
 * shapes this repo actually uses: a rename inside a do block, the
 * drop-then-create trigger idiom, and table names reached through a
 * module-scope const.
 *
 * Second, and more important, the committed manifests are re-derived here and
 * compared whole. Add a table and forget to regenerate, and this fails.
 *
 * Run: node --test test/schemaRequirements.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseMigrations,
  scanCode,
  deriveRequirements,
  declaredObjects,
} = require('../lib/schemaRequirements');
const { ROOT, MIGRATIONS_DIR, SURFACES } = require('../lib/schemaSurfaces');
const { buildManifest, serialize } = require('../scripts/generate-schema-manifest');

const temps = [];

/** Write a throwaway directory of files and return its path. */
function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flizy-schema-'));
  temps.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Migration replay
// ---------------------------------------------------------------------------

describe('migration replay', () => {
  it('carries a rename to the new name and keeps the original provider', () => {
    const dir = fixture({
      '001_create.sql': `
        create table if not exists public.old_name (id uuid primary key);
        alter table public.old_name enable row level security;
      `,
      '002_rename.sql': `
        do $$
        begin
          if to_regclass('public.old_name') is not null then
            alter table public.old_name rename to new_name;
          end if;
        end
        $$;
      `,
    });

    const mig = parseMigrations(dir);
    assert.equal(mig.objects.has('table:old_name'), false);
    assert.equal(mig.objects.get('table:new_name').file, '001_create.sql');
    // RLS belongs to the table, not to the name it used to have.
    assert.equal(mig.rlsEnabled.has('new_name'), true);
    assert.equal(mig.rlsEnabled.has('old_name'), false);
  });

  it('nets drop-then-create to present, which is the idempotency idiom here', () => {
    const dir = fixture({
      '001.sql': `
        create table if not exists public.t (id int);
        drop trigger if exists t_touch on public.t;
        create trigger t_touch
          before update on public.t
          for each row
          execute function public.touch();
      `,
    });

    const mig = parseMigrations(dir);
    assert.equal(mig.objects.has('trigger:t_touch'), true);
    assert.deepEqual(mig.triggers.get('t_touch'), {
      table: 't',
      fn: 'touch',
      file: '001.sql',
    });
  });

  it('honours a real drop that is not followed by a create', () => {
    const dir = fixture({
      '001.sql': 'create table if not exists public.gone (id int);',
      '002.sql': 'drop table if exists public.gone;',
    });
    assert.equal(parseMigrations(dir).objects.has('table:gone'), false);
  });

  it('refuses an unrecognised create statement instead of guessing', () => {
    const dir = fixture({
      '001.sql': 'create materialised_thing public.whatever (id int);',
    });
    assert.throws(() => parseMigrations(dir), /unrecognised create statement/i);
  });

  it('does not read DDL out of a string literal', () => {
    const dir = fixture({
      '001.sql': `
        create table if not exists public.real_one (id int);
        comment on table public.real_one is 'create table public.fake_one (x int)';
      `,
    });
    const mig = parseMigrations(dir);
    assert.equal(mig.objects.has('table:real_one'), true);
    assert.equal(mig.objects.has('table:fake_one'), false);
  });
});

// ---------------------------------------------------------------------------
// Code scan
// ---------------------------------------------------------------------------

describe('code scan', () => {
  it('resolves a table name reached through a module-scope const', () => {
    const dir = fixture({
      'a.js': [
        "const IDENTITY_TABLE = 'channel_identities';",
        'async function read(supabase) {',
        '  return supabase.from(IDENTITY_TABLE).select("*");',
        '}',
      ].join('\n'),
    });
    const { tables } = scanCode([dir]);
    assert.equal(tables.has('channel_identities'), true);
  });

  it('resolves an exported const, which the web mirror uses', () => {
    const dir = fixture({
      'a.js': [
        "export const GUARD = 'schema_guard_objects';",
        'export const run = (db) => db.rpc(GUARD);',
      ].join('\n'),
    });
    const { rpcs } = scanCode([dir]);
    assert.equal(rpcs.has('schema_guard_objects'), true);
  });

  it('ignores Buffer.from and Array.from', () => {
    const dir = fixture({
      'a.js': [
        'const a = Buffer.from(expected);',
        'const b = Array.from({ length: 3 });',
        "const c = db.from('accounts');",
      ].join('\n'),
    });
    const { tables } = scanCode([dir]);
    assert.deepEqual([...tables.keys()], ['accounts']);
  });

  it('ignores calls written in comments', () => {
    const dir = fixture({
      'a.js': [
        '/**',
        " * Scans .from('documented_only') and nothing else.",
        ' */',
        "// db.from('commented_out')",
        "const c = db.from('accounts');",
      ].join('\n'),
    });
    const { tables } = scanCode([dir]);
    assert.deepEqual([...tables.keys()], ['accounts']);
  });

  it('throws rather than skipping a table name it cannot resolve', () => {
    const dir = fixture({
      'a.js': ['function read(db, table) {', '  return db.from(table);', '}'].join('\n'),
    });
    assert.throws(() => scanCode([dir]), /does not resolve to a table name/);
  });

  it('throws rather than skipping an rpc name it cannot resolve', () => {
    const dir = fixture({
      'a.js': ['function call(db, fn) {', '  return db.rpc(fn, {});', '}'].join('\n'),
    });
    assert.throws(() => scanCode([dir]), /does not resolve to a function name/);
  });
});

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

describe('requirements', () => {
  it('attaches the trigger on a required table, and the functions it reaches', () => {
    const migrations = fixture({
      '001.sql': `
        create table if not exists public.accounts (id int, username text);
        create table if not exists public.reserved_usernames (normalized_name text primary key);

        create or replace function public.reserved_key(raw text)
        returns text language sql immutable as $fn$
          select lower(raw);
        $fn$;

        create or replace function public.enforce_not_reserved()
        returns trigger language plpgsql as $fn$
        begin
          if exists (
            select 1 from public.reserved_usernames r
            where r.normalized_name = public.reserved_key(new.username)
          ) then
            raise exception 'username is reserved';
          end if;
          return new;
        end
        $fn$;

        drop trigger if exists accounts_not_reserved on public.accounts;
        create trigger accounts_not_reserved
          before insert or update of username on public.accounts
          for each row execute function public.enforce_not_reserved();
      `,
    });

    // Touching accounts is what pulls the trigger in. A surface that never
    // writes accounts does not need the trigger, and must not be blocked on it.
    const code = fixture({
      'signup.js': [
        "const check = (db) => db.from('reserved_usernames').select('normalized_name');",
        "const save = (db) => db.from('accounts').insert({ username: 'x' });",
      ].join('\n'),
    });

    const { objects } = deriveRequirements({
      surface: 'test',
      codeRoots: [code],
      migrationsDir: migrations,
    });

    const names = objects.map((o) => `${o.kind}:${o.name}`).sort();
    assert.deepEqual(names, [
      // reached only through the trigger's body, never named in JS
      'function:enforce_not_reserved',
      'function:reserved_key',
      'table:accounts',
      'table:reserved_usernames',
      'trigger:accounts_not_reserved',
    ]);
  });

  it('refuses when code needs a table no migration creates', () => {
    const migrations = fixture({ '001.sql': 'create table if not exists public.a (id int);' });
    const code = fixture({ 'x.js': "const q = (db) => db.from('nowhere_table');" });

    assert.throws(
      () => deriveRequirements({ surface: 'test', codeRoots: [code], migrationsDir: migrations }),
      /no migration creates it/
    );
  });
});

// ---------------------------------------------------------------------------
// Against the real repository
// ---------------------------------------------------------------------------

describe('this repository', () => {
  it('derives the reserved-usernames chain to the migration that supplies it', () => {
    const { objects } = deriveRequirements({
      surface: 'web',
      codeRoots: SURFACES.find((s) => s.name === 'web').codeRoots,
      migrationsDir: MIGRATIONS_DIR,
      relativeTo: ROOT,
    });

    const chain = objects.filter((o) =>
      ['reserved_usernames', 'accounts_username_not_reserved', 'username_reserved_key'].includes(
        o.name
      )
    );

    assert.equal(chain.length, 3, 'table, trigger and normalise function');
    for (const object of chain) {
      assert.equal(object.providedBy, '20260811000000_reserved_usernames.sql');
    }
  });

  it('resolves every required object to a migration file, for both surfaces', () => {
    for (const surface of SURFACES) {
      const { objects } = deriveRequirements({
        surface: surface.name,
        codeRoots: surface.codeRoots,
        migrationsDir: MIGRATIONS_DIR,
        relativeTo: ROOT,
      });
      assert.ok(objects.length > 0, `${surface.name} requires at least one object`);
      for (const object of objects) {
        assert.match(object.providedBy, /\.sql$/, `${object.kind} ${object.name}`);
      }
    }
  });

  it('keeps the committed manifests equal to a fresh derivation', () => {
    for (const surface of SURFACES) {
      const expected = serialize(buildManifest(surface));
      const actual = fs.readFileSync(surface.manifest, 'utf8');
      assert.equal(
        actual,
        expected,
        `${surface.name} manifest is stale. Run: node scripts/generate-schema-manifest.js`
      );
    }
  });

  it('derives the RLS gap list rather than carrying it by hand', () => {
    const declared = declaredObjects(MIGRATIONS_DIR);
    const gaps = declared.tables.filter((t) => !declared.rlsEnabled.includes(t));
    // Pre-existing and also true in production. Recorded so a third one is news.
    assert.deepEqual(gaps, ['account_emails', 'email_verifications']);
  });

  it('says reserved_usernames has RLS enabled, which the old hand list missed', () => {
    const declared = declaredObjects(MIGRATIONS_DIR);
    assert.ok(declared.rlsEnabled.includes('reserved_usernames'));
  });
});
