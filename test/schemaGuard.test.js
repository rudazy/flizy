/**
 * The startup schema guard, and the drift guard for its web mirror.
 *
 * web/lib/schemaGuard.js is a hand-kept copy of lib/schemaGuard.js, because the
 * Vercel Root Directory is web so ../lib never reaches the deploy. The same
 * reasoning as the bind mirror applies: two copies of the code that decides
 * whether a deploy is safe is exactly the duplication that rots quietly. Every
 * comparison below therefore runs against both implementations and asserts they
 * agree on the missing set and on the message text.
 *
 * The centrepiece is the incident replay: the real committed bot manifest,
 * checked against a database that has everything except what
 * 20260811000000_reserved_usernames.sql supplies. That is the shape production
 * was in when signup started failing.
 *
 * Run: node --test test/schemaGuard.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const bot = require('../lib/schemaGuard');
const botManifest = require('../lib/generated/schemaManifest.json');

let web;

before(async () => {
  web = await import('../web/lib/schemaGuard.mjs');
});

/** Build a schema_guard_objects() payload that satisfies a manifest. */
function presentFor(manifest, omit = []) {
  const dropped = new Set(omit);
  const present = { tables: [], views: [], functions: [], triggers: [], rls_enabled: [] };
  const bucket = { table: 'tables', view: 'views', function: 'functions', trigger: 'triggers' };

  for (const object of manifest.objects) {
    if (dropped.has(object.name)) continue;
    present[bucket[object.kind]].push(object.name);
  }
  return present;
}

/** Everything 20260811000000_reserved_usernames.sql creates. */
const RESERVED_OBJECTS = botManifest.objects
  .filter((o) => o.providedBy === '20260811000000_reserved_usernames.sql')
  .map((o) => o.name);

function fakeSupabase(payload, { error = null, throws = null } = {}) {
  return {
    async rpc(name) {
      assert.equal(name, 'schema_guard_objects');
      if (throws) throw throws;
      return { data: payload, error };
    },
  };
}

// ---------------------------------------------------------------------------

describe('diffObjects', () => {
  const required = [
    { kind: 'table', name: 'accounts', providedBy: '001.sql', requiredBy: 'lib/a.js' },
    { kind: 'trigger', name: 't_guard', providedBy: '002.sql', requiredBy: 'trigger on accounts' },
  ];

  it('reports what is absent, on both implementations', () => {
    const present = { tables: ['accounts'], views: [], functions: [], triggers: [] };
    for (const impl of [bot, web]) {
      const missing = impl.diffObjects(required, present);
      assert.deepEqual(missing.map((o) => o.name), ['t_guard']);
    }
  });

  it('passes when everything is present, on both implementations', () => {
    const present = { tables: ['accounts'], views: [], functions: [], triggers: ['t_guard'] };
    for (const impl of [bot, web]) {
      assert.deepEqual(impl.diffObjects(required, present), []);
    }
  });

  it('lets a view satisfy a table requirement, on both implementations', () => {
    const one = [{ kind: 'table', name: 'whatsapp_identities', providedBy: '1.sql', requiredBy: 'x' }];
    const present = { tables: [], views: ['whatsapp_identities'], functions: [], triggers: [] };
    for (const impl of [bot, web]) {
      assert.deepEqual(impl.diffObjects(one, present), []);
    }
  });

  it('refuses an object kind it does not understand, on both implementations', () => {
    const odd = [{ kind: 'sequence', name: 's', providedBy: '1.sql', requiredBy: 'x' }];
    const present = { tables: [], views: [], functions: [], triggers: [] };
    for (const impl of [bot, web]) {
      assert.throws(() => impl.diffObjects(odd, present), /unknown object kind/);
    }
  });
});

describe('the failure message', () => {
  const missing = [
    {
      kind: 'table',
      name: 'reserved_usernames',
      providedBy: '20260811000000_reserved_usernames.sql',
      requiredBy: 'lib/username.js',
    },
  ];

  it('names the object, who needs it and the file that supplies it', () => {
    const text = bot.formatMissing(missing, 'bot');
    assert.match(text, /reserved_usernames/);
    assert.match(text, /lib\/username\.js/);
    assert.match(text, /supabase\/migrations\/20260811000000_reserved_usernames\.sql/);
    assert.match(text, /Apply that migration in the Supabase SQL editor/);
  });

  it('is character for character the same in the web mirror', () => {
    assert.equal(web.formatMissing(missing, 'bot'), bot.formatMissing(missing, 'bot'));
    assert.equal(
      web.formatGuardUnavailable('boom', '20260812000000_schema_guard.sql'),
      bot.formatGuardUnavailable('boom', '20260812000000_schema_guard.sql')
    );
  });
});

describe('assertSchema', () => {
  it('resolves when the database has everything', async () => {
    const supabase = fakeSupabase(presentFor(botManifest));
    const result = await bot.assertSchema(supabase, { manifest: botManifest });
    assert.equal(result.surface, 'bot');
    assert.equal(result.checked, botManifest.objects.length);
  });

  it('throws a guard error, not a stack trace, when an object is absent', async () => {
    const supabase = fakeSupabase(presentFor(botManifest, ['transfers']));
    await assert.rejects(
      () => bot.assertSchema(supabase, { manifest: botManifest }),
      (err) => {
        assert.equal(err.schemaGuard, true);
        assert.match(err.message, /missing 1 object required by this code \(bot\)/);
        assert.match(err.message, /table transfers/);
        return true;
      }
    );
  });

  it('names its own migration when the guard function is not there yet', async () => {
    const supabase = fakeSupabase(null, {
      error: { message: 'function public.schema_guard_objects() does not exist' },
    });
    await assert.rejects(
      () => bot.assertSchema(supabase, { manifest: botManifest }),
      (err) => {
        assert.equal(err.schemaGuard, true);
        assert.match(err.message, /cannot call public\.schema_guard_objects\(\)/);
        assert.match(err.message, /20260812000000_schema_guard\.sql/);
        return true;
      }
    );
  });

  it('treats a thrown transport error the same way', async () => {
    const supabase = fakeSupabase(null, { throws: new Error('fetch failed') });
    await assert.rejects(
      () => bot.assertSchema(supabase, { manifest: botManifest }),
      /fetch failed/
    );
  });
});

// ---------------------------------------------------------------------------
// The incident
// ---------------------------------------------------------------------------

describe('the reserved-usernames incident', () => {
  it('supplies more than the table alone, so the trigger cannot be missed', () => {
    assert.ok(RESERVED_OBJECTS.includes('reserved_usernames'), 'the table');
    assert.ok(RESERVED_OBJECTS.includes('accounts_username_not_reserved'), 'the trigger');
    assert.ok(RESERVED_OBJECTS.includes('username_reserved_key'), 'the normalise function');
    assert.equal(RESERVED_OBJECTS.length, 4);
  });

  it('refuses to start against the database production actually had', async () => {
    const supabase = fakeSupabase(presentFor(botManifest, RESERVED_OBJECTS));

    await assert.rejects(
      () => bot.assertSchema(supabase, { manifest: botManifest }),
      (err) => {
        assert.equal(err.schemaGuard, true);
        assert.match(err.message, /table reserved_usernames/);
        assert.match(err.message, /trigger accounts_username_not_reserved/);
        assert.match(err.message, /supabase\/migrations\/20260811000000_reserved_usernames\.sql/);
        return true;
      }
    );
  });

  it('would also have caught the quieter half: table applied, trigger not', async () => {
    const supabase = fakeSupabase(presentFor(botManifest, ['accounts_username_not_reserved']));

    await assert.rejects(
      () => bot.assertSchema(supabase, { manifest: botManifest }),
      (err) => {
        assert.match(err.message, /trigger accounts_username_not_reserved/);
        return true;
      }
    );
  });

  it('reaches the same verdict through the web mirror', async () => {
    const webManifest = require('../web/lib/generated/schemaManifest.json');
    const omit = webManifest.objects
      .filter((o) => o.providedBy === '20260811000000_reserved_usernames.sql')
      .map((o) => o.name);

    const supabase = fakeSupabase(presentFor(webManifest, omit));
    const result = await web.checkSchema(supabase, webManifest);

    assert.equal(result.ok, false);
    assert.match(result.message, /table reserved_usernames/);
    assert.match(result.message, /20260811000000_reserved_usernames\.sql/);
  });
});
