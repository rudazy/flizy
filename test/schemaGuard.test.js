/**
 * The startup schema guard, and the drift guard for its web mirror.
 *
 * web/lib/schemaGuard.mjs is a hand-kept copy of lib/schemaGuard.js, because the
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
  const present = { tables: [], views: [], functions: [], triggers: [], checks: [], rls_enabled: [] };
  const bucket = { table: 'tables', view: 'views', function: 'functions', trigger: 'triggers', check: 'checks' };

  for (const object of manifest.objects) {
    if (dropped.has(object.name)) continue;
    present[bucket[object.kind]].push(object.name);
  }
  present.rls_enabled = [...present.tables];
  return present;
}

/** Everything 20260811000000_reserved_usernames.sql creates. */
const RESERVED_OBJECTS = botManifest.objects
  .filter((o) => o.providedBy === '20260811000000_reserved_usernames.sql')
  .map((o) => o.name);

const EMPTY = { entries: [] };

/**
 * A compliant exposure report: the browser roles reach nothing. The non-browser
 * grants are there to prove the rule ignores service_role and postgres; the
 * real function filters them out in SQL already.
 */
function compliantExposure() {
  return {
    relation_grants: [
      { name: 'accounts', type: 'table', grantee: 'service_role', privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
    ],
    function_execute: [
      { name: 'debit_user_balance(uuid,numeric)', grantee: 'service_role', security_definer: true },
    ],
    definer_functions: [
      { name: 'debit_user_balance(uuid,numeric)', search_path: 'public, pg_temp' },
    ],
    default_acl: [
      { role: 'postgres', schema: 'public', object_type: 'tables', grantee: 'service_role', privileges: ['SELECT'] },
    ],
  };
}

/** Add an exposure report (compliant unless changed) to a presence payload. */
function withExposure(present, change = () => {}) {
  const exposure = compliantExposure();
  change(exposure, present);
  return { ...present, exposure };
}

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
    const findings = [
      { kind: 'rls_off', name: 'account_emails', grantee: null, detail: 'row level security off' },
      { kind: 'function_execute', name: 'f(uuid)', grantee: 'PUBLIC', detail: 'EXECUTE', reason: 'r' },
    ];
    assert.equal(web.formatExposure(findings, 'web'), bot.formatExposure(findings, 'web'));
    assert.equal(web.formatAllowlisted(findings), bot.formatAllowlisted(findings));
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
        // The newest migration that replaces the guard function is the one to apply.
        assert.match(err.message, /20261015140000_lock_public_exposure\.sql/);
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

  it('reports a public table with RLS off instead of throwing', async () => {
    const payload = withExposure(presentFor(botManifest));
    payload.rls_enabled = payload.rls_enabled.filter((t) => t !== 'accounts');
    const result = await bot.assertSchema(fakeSupabase(payload), { manifest: botManifest, allowlist: EMPTY });
    assert.match(result.exposure.message, /rls_off accounts/);
    assert.match(result.exposure.message, /row level security off/);
  });

  it('web checkSchema reports RLS off as exposure, not as a presence failure', async () => {
    const payload = withExposure(presentFor(botManifest));
    payload.rls_enabled = payload.rls_enabled.filter((t) => t !== 'accounts');
    const result = await web.checkSchema(fakeSupabase(payload), botManifest, EMPTY);
    assert.equal(result.ok, true);
    assert.equal(result.exposure.message, bot.formatExposure(result.exposure.findings, 'bot'));
    assert.deepEqual(result.exposure.findings.map((f) => f.name), ['accounts']);
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
    assert.ok(RESERVED_OBJECTS.includes('reserved_usernames.reserved_usernames_category_nonempty'), 'its check rules');
    assert.equal(RESERVED_OBJECTS.length, 6);
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

// ---------------------------------------------------------------------------
// Check constraints
// ---------------------------------------------------------------------------

describe('check constraints', () => {
  const RULE = 'transfers.transfers_amount_eth_check_v2';
  const webManifest = require('../web/lib/generated/schemaManifest.json');

  it('the bot and the site both require the transfers amount rule', () => {
    for (const manifest of [botManifest, webManifest]) {
      const rule = manifest.objects.find((o) => o.kind === 'check' && o.name === RULE);
      assert.ok(rule, manifest.surface);
      assert.equal(rule.providedBy, '20261002150000_schema_guard_checks.sql');
    }
  });

  it('refuses to start when a required rule is missing, and names its migration', async () => {
    await assert.rejects(
      () => bot.assertSchema(fakeSupabase(presentFor(botManifest, [RULE])), { manifest: botManifest }),
      (err) => {
        assert.equal(err.schemaGuard, true);
        assert.ok(err.message.includes(`check ${RULE}`));
        assert.ok(err.message.includes('20261002150000_schema_guard_checks.sql'));
        return true;
      }
    );
    const result = await web.checkSchema(fakeSupabase(presentFor(webManifest, [RULE])), webManifest);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes(`check ${RULE}`));
  });

  it('a guard function from before checks were tracked fails once, by name, not as every rule missing', async () => {
    const old = presentFor(botManifest);
    delete old.checks;
    await assert.rejects(
      () => bot.assertSchema(fakeSupabase(old), { manifest: botManifest }),
      (err) => {
        assert.ok(err.message.includes('does not report check constraints'));
        // The newest migration that replaces the guard function is the one to apply.
        assert.ok(err.message.includes('20261015140000_lock_public_exposure.sql'));
        assert.ok(!err.message.includes('is missing'));
        return true;
      }
    );
    const result = await web.checkSchema(fakeSupabase(old), webManifest);
    assert.equal(result.ok, false);
    assert.ok(result.message.includes('does not report check constraints'));
  });
});

// ---------------------------------------------------------------------------
// Exposure: anon, authenticated and PUBLIC must reach nothing in public
// ---------------------------------------------------------------------------

describe('exposure', () => {
  const webManifest = require('../web/lib/generated/schemaManifest.json');
  const base = () => presentFor(botManifest);

  /** Run diffExposure on both implementations and insist they agree. */
  function both(payload, allowlist = EMPTY) {
    const fromBot = bot.diffExposure(payload, allowlist);
    const fromWeb = web.diffExposure(payload, allowlist);
    assert.deepEqual(fromWeb, fromBot);
    return fromBot;
  }

  const labels = (diff) => diff.findings.map((f) => `${f.kind} ${f.name} ${f.grantee}`);

  it('passes a compliant schema, ignoring grants to service_role and postgres', () => {
    const diff = both(withExposure(base()));
    assert.deepEqual(diff, { findings: [], allowlisted: [] });
  });

  it('fails the account_emails case: RLS off plus the default anon and authenticated grants', () => {
    const payload = withExposure(base(), (exposure, present) => {
      present.rls_enabled = present.rls_enabled.filter((t) => t !== 'account_emails');
      for (const grantee of ['anon', 'authenticated']) {
        exposure.relation_grants.push({
          name: 'account_emails',
          type: 'table',
          grantee,
          privileges: ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
        });
      }
    });
    const diff = both(payload);
    assert.deepEqual(labels(diff), [
      'rls_off account_emails null',
      'relation_grant account_emails anon',
      'relation_grant account_emails authenticated',
    ]);
    assert.match(bot.formatExposure(diff.findings, 'bot'), /SCHEMA EXPOSURE: 3 findings/);
  });

  it('fails a SECURITY DEFINER function anon can execute', () => {
    const payload = withExposure(base(), (exposure) => {
      exposure.function_execute.push({ name: 'try_count_invite(uuid)', grantee: 'anon', security_definer: true });
    });
    const diff = both(payload);
    assert.deepEqual(labels(diff), ['function_execute try_count_invite(uuid) anon']);
    assert.equal(diff.findings[0].detail, 'EXECUTE, SECURITY DEFINER');
  });

  it('fails a function executable through PUBLIC, even an invoker one', () => {
    const payload = withExposure(base(), (exposure) => {
      exposure.function_execute.push({ name: 'username_reserved_key(text)', grantee: 'PUBLIC', security_definer: false });
    });
    assert.deepEqual(labels(both(payload)), ['function_execute username_reserved_key(text) PUBLIC']);
  });

  it('fails default privileges that still grant to anon', () => {
    const payload = withExposure(base(), (exposure) => {
      exposure.default_acl.push({
        role: 'postgres', schema: 'public', object_type: 'tables', grantee: 'anon', privileges: ['SELECT'],
      });
    });
    assert.deepEqual(labels(both(payload)), ['default_acl postgres:public:tables anon']);
  });

  it('fails the built-in PUBLIC EXECUTE default for new functions', () => {
    const payload = withExposure(base(), (exposure) => {
      exposure.default_acl.push({
        role: 'postgres', schema: '*', object_type: 'functions', grantee: 'PUBLIC', privileges: ['EXECUTE'],
      });
    });
    assert.deepEqual(labels(both(payload)), ['default_acl postgres:*:functions PUBLIC']);
  });

  it('fails a SECURITY DEFINER function with no pinned search_path', () => {
    const payload = withExposure(base(), (exposure) => {
      exposure.definer_functions.push({ name: 'f(uuid)', search_path: null });
    });
    assert.deepEqual(labels(both(payload)), ['definer_search_path f(uuid) null']);
  });

  it('passes an allowlisted exception and prints it with its reason', () => {
    const payload = withExposure(base(), (exposure) => {
      for (const grantee of ['anon', 'authenticated']) {
        exposure.default_acl.push({
          role: 'supabase_admin', schema: 'public', object_type: 'tables', grantee, privileges: ['SELECT'],
        });
      }
    });
    const allowlist = {
      entries: [{ kind: 'default_acl', name: 'supabase_admin:public:tables', reason: 'platform owned' }],
    };
    const diff = both(payload, allowlist);
    assert.deepEqual(diff.findings, []);
    assert.equal(diff.allowlisted.length, 2);

    const printed = [];
    const reported = [];
    const result = bot.exposureResult(payload, botManifest, allowlist);
    const fired = bot.reportExposure(result, {
      log: (m) => printed.push(m),
      warn: (m) => printed.push(m),
      report: (m) => reported.push(m),
    });
    assert.equal(fired, false);
    assert.deepEqual(reported, []);
    assert.equal(printed.length, 1);
    assert.match(printed[0], /Schema exposure allowlist: 2 accepted/);
    assert.match(printed[0], /default_acl supabase_admin:public:tables \(anon\)/);
    assert.match(printed[0], /reason: platform owned/);
  });

  it('an allowlist entry with a grantee covers only that grantee', () => {
    const payload = withExposure(base(), (exposure) => {
      exposure.function_execute.push(
        { name: 'f(uuid)', grantee: 'anon', security_definer: false },
        { name: 'f(uuid)', grantee: 'PUBLIC', security_definer: false }
      );
    });
    const diff = both(payload, {
      entries: [{ kind: 'function_execute', name: 'f(uuid)', grantee: 'anon', reason: 'r' }],
    });
    assert.deepEqual(labels(diff), ['function_execute f(uuid) PUBLIC']);
  });

  it('refuses an allowlist entry without a written reason, on both implementations', () => {
    const allowlist = { entries: [{ kind: 'rls_off', name: 'accounts', reason: '  ' }] };
    for (const impl of [bot, web]) {
      assert.throws(() => impl.diffExposure(withExposure(base()), allowlist), /has no reason/);
    }
  });

  it('refuses an allowlist entry of an unknown kind', () => {
    const allowlist = { entries: [{ kind: 'everything', name: 'x', reason: 'r' }] };
    assert.throws(() => bot.diffExposure(withExposure(base()), allowlist), /unknown kind/);
  });

  it('says so, by migration, when the guard function predates the exposure report', () => {
    const result = bot.exposureResult(base(), botManifest, EMPTY);
    assert.equal(result.unavailable, true);
    assert.match(result.message, /does not report exposure/);
    assert.match(result.message, /20261015140000_lock_public_exposure\.sql/);
    assert.deepEqual(web.exposureResult(base(), botManifest, EMPTY), result);
  });

  it('the bot reports exposure loudly and to the reporter, and keeps running', async () => {
    const payload = withExposure(base(), (exposure) => {
      exposure.function_execute.push({ name: 'try_count_invite(uuid)', grantee: 'PUBLIC', security_definer: true });
    });
    const result = await bot.assertSchema(fakeSupabase(payload), { manifest: botManifest, allowlist: EMPTY });
    const warned = [];
    const reported = [];
    const fired = bot.reportExposure(result.exposure, {
      log: () => {},
      warn: (m) => warned.push(m),
      report: (m) => reported.push(m),
    });
    assert.equal(fired, true);
    assert.equal(reported.length, 1);
    assert.match(reported[0], /^SCHEMA EXPOSURE: 1 finding in the public schema \(bot\)/);
    assert.ok(warned[0].includes(reported[0]));
  });

  it('presence failures still refuse to start, exposure or not', async () => {
    const payload = withExposure(presentFor(botManifest, ['transfers']), (exposure) => {
      exposure.function_execute.push({ name: 'f(uuid)', grantee: 'anon', security_definer: false });
    });
    await assert.rejects(
      () => bot.assertSchema(fakeSupabase(payload), { manifest: botManifest, allowlist: EMPTY }),
      (err) => err.schemaGuard === true && /table transfers/.test(err.message)
    );
  });

  it('the web check keeps ok to presence and carries exposure beside it', async () => {
    const payload = withExposure(presentFor(webManifest), (exposure) => {
      exposure.relation_grants.push({ name: 'task_ref_seq', type: 'sequence', grantee: 'anon', privileges: ['USAGE'] });
    });
    const result = await web.checkSchema(fakeSupabase(payload), webManifest, EMPTY);
    assert.equal(result.ok, true);
    assert.match(result.exposure.message, /relation_grant task_ref_seq \(anon\)/);
    assert.match(result.exposure.message, /sequence: USAGE/);
  });

  it('the web check fails closed when no allowlist is passed', async () => {
    const payload = withExposure(presentFor(webManifest), (exposure) => {
      exposure.default_acl.push({
        role: 'supabase_admin', schema: 'public', object_type: 'tables', grantee: 'anon', privileges: ['SELECT'],
      });
    });
    const result = await web.checkSchema(fakeSupabase(payload), webManifest);
    assert.equal(result.exposure.findings.length, 1);
  });
});

describe('the committed exposure allowlist', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('is byte for byte the same in lib/ and web/lib/', () => {
    assert.equal(read('web/lib/schemaExposureAllowlist.json'), read('lib/schemaExposureAllowlist.json'));
  });

  it('gives every entry a kind, a name and a written reason', () => {
    const allowlist = JSON.parse(read('lib/schemaExposureAllowlist.json'));
    assert.doesNotThrow(() => bot.diffExposure(withExposure(presentFor(botManifest)), allowlist));
    for (const entry of allowlist.entries) assert.ok(entry.reason.length > 40, entry.name);
  });

  it('both sides send the same fixed Sentry tag', () => {
    assert.equal(bot.EXPOSURE_ALERT_TAG, 'schema_exposure');
    assert.equal(web.EXPOSURE_ALERT_TAG, bot.EXPOSURE_ALERT_TAG);
  });
});

describe('the daily check', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const route = fs.readFileSync(path.join(root, 'web/app/api/cron/schema-check/route.ts'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'web/vercel.json'), 'utf8'));

  it('the Sentry monitor expects the schedule Vercel actually runs', () => {
    const cron = vercel.crons.find((c) => c.path === '/api/cron/schema-check');
    assert.ok(cron, 'web/vercel.json schedules /api/cron/schema-check');
    const monitored = route.match(/schedule:\s*\{\s*type:\s*'crontab',\s*value:\s*'([^']+)'/);
    assert.ok(monitored, 'route declares a crontab monitor schedule');
    assert.equal(monitored[1], cron.schedule);
    assert.match(route, /timezone:\s*'UTC'/);
  });

  it('checks in only after the bearer check passes', () => {
    const auth = route.indexOf('if (!authorized(');
    const checkIn = route.indexOf("status: 'in_progress'");
    assert.ok(auth > 0 && checkIn > auth);
  });
});
