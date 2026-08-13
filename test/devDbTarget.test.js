/**
 * The dev database guard.
 *
 * This is the check that stands between a migration run and the production
 * database, and it now has a second connection route (the pooler) that did not
 * exist when it was written. The risk of adding a route is that it becomes a
 * way around the guard, so most of what follows is about proving it is not:
 * the tenant is pinned by the postgres.<ref> username built from the ref that
 * already passed the two-place check, and the host is confined to Supabase.
 *
 * resolveDevTarget is pure, so all of this runs without a database. That is
 * deliberate: the scripts themselves cannot be exercised without a filled in
 * .env.dev, so the logic has to be testable separately from the wiring.
 *
 * Run: node --test test/devDbTarget.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { resolveDevTarget, describeTarget } = require('../scripts/devDbTarget');

const DEV_REF = 'tkkxcmrmtzpplydbksfe';
const PROD_REF = 'wbqhvmtiocoozjgwdsiq';

/** A valid, minimal dev env. */
function env(overrides = {}) {
  return {
    DEV_SUPABASE_REF: DEV_REF,
    SUPABASE_URL: `https://${DEV_REF}.supabase.co`,
    SUPABASE_DB_PASSWORD: 'not-a-real-password',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The guard, unchanged
// ---------------------------------------------------------------------------

describe('the dev guard', () => {
  it('refuses when the URL and the declared dev ref disagree', () => {
    assert.throws(
      () => resolveDevTarget(env({ SUPABASE_URL: `https://${PROD_REF}.supabase.co` })),
      /dev guard tripped/
    );
  });

  it('refuses a URL that is not a Supabase project URL', () => {
    assert.throws(
      () => resolveDevTarget(env({ SUPABASE_URL: 'https://example.com' })),
      /not a Supabase project URL/
    );
  });

  it('refuses a ref listed in BLOCKED_SUPABASE_REFS', () => {
    assert.throws(
      () => resolveDevTarget(env({ BLOCKED_SUPABASE_REFS: `foo, ${DEV_REF}` })),
      /BLOCKED_SUPABASE_REFS/
    );
  });

  for (const key of ['DEV_SUPABASE_REF', 'SUPABASE_URL', 'SUPABASE_DB_PASSWORD']) {
    it(`refuses when ${key} is missing`, () => {
      assert.throws(() => resolveDevTarget(env({ [key]: '' })), new RegExp(key));
    });

    it(`refuses when ${key} is still template text`, () => {
      assert.throws(
        () => resolveDevTarget(env({ [key]: 'your_value_here' })),
        new RegExp(key)
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('direct route', () => {
  it('is the default when no pooler host is set', () => {
    const target = resolveDevTarget(env());
    assert.equal(target.mode, 'direct');
    assert.equal(target.host, `db.${DEV_REF}.supabase.co`);
    assert.equal(target.port, 5432);
    assert.equal(target.user, 'postgres');
    assert.equal(target.ref, DEV_REF);
  });

  it('treats an empty or template pooler host as unset', () => {
    for (const value of ['', '   ', 'your_pooler_host']) {
      assert.equal(resolveDevTarget(env({ SUPABASE_DB_POOLER_HOST: value })).mode, 'direct');
    }
  });
});

describe('pooler route', () => {
  const poolerEnv = env({ SUPABASE_DB_POOLER_HOST: 'aws-0-eu-west-1.pooler.supabase.com' });

  it('uses the pooler host and derives the tenant username from the ref', () => {
    const target = resolveDevTarget(poolerEnv);
    assert.equal(target.mode, 'pooler');
    assert.equal(target.host, 'aws-0-eu-west-1.pooler.supabase.com');
    assert.equal(target.port, 5432, 'session mode, safe for multi-statement DDL');
    assert.equal(target.user, `postgres.${DEV_REF}`);
    assert.equal(target.ref, DEV_REF);
  });

  it('accepts an explicit port', () => {
    const target = resolveDevTarget({ ...poolerEnv, SUPABASE_DB_POOLER_PORT: '6543' });
    assert.equal(target.port, 6543);
  });

  it('refuses a port that is not a port', () => {
    for (const bad of ['abc', '0', '70000', '5432.5']) {
      assert.throws(
        () => resolveDevTarget({ ...poolerEnv, SUPABASE_DB_POOLER_PORT: bad }),
        /not a valid port/
      );
    }
  });

  it('refuses a host that is not a Supabase pooler', () => {
    for (const bad of [
      'evil.example.com',
      'pooler.supabase.com.evil.net',
      `db.${PROD_REF}.supabase.co`,
      'aws-0-eu-west-1.pooler.supabase.com.attacker.io',
    ]) {
      assert.throws(
        () => resolveDevTarget(env({ SUPABASE_DB_POOLER_HOST: bad })),
        /not a Supabase pooler hostname/,
        bad
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The pooler must not become a way around the guard
// ---------------------------------------------------------------------------

describe('the pooler does not widen the guard', () => {
  it('still trips the two-place check before any route is chosen', () => {
    assert.throws(
      () =>
        resolveDevTarget(
          env({
            SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
            SUPABASE_DB_POOLER_HOST: 'aws-0-eu-west-1.pooler.supabase.com',
          })
        ),
      /dev guard tripped/
    );
  });

  it('pins the tenant to the guarded ref, whatever region the host names', () => {
    // Changing the pooler host changes the region, never the project. Supabase
    // routes on the username, and the username carries the checked ref.
    for (const host of [
      'aws-0-eu-west-1.pooler.supabase.com',
      'aws-1-us-east-2.pooler.supabase.com',
      'aws-0-ap-southeast-1.pooler.supabase.com',
    ]) {
      const target = resolveDevTarget(env({ SUPABASE_DB_POOLER_HOST: host }));
      assert.equal(target.user, `postgres.${DEV_REF}`);
      assert.ok(!target.user.includes(PROD_REF), 'never names the production ref');
    }
  });

  it('cannot be pointed at production through the ref in the username', () => {
    // Even if someone writes a production-looking pooler user by hand, the
    // username is built here and not read from the file.
    const target = resolveDevTarget(
      env({
        SUPABASE_DB_POOLER_HOST: 'aws-0-eu-west-1.pooler.supabase.com',
        SUPABASE_DB_POOLER_USER: `postgres.${PROD_REF}`,
      })
    );
    assert.equal(target.user, `postgres.${DEV_REF}`);
  });
});

// ---------------------------------------------------------------------------
// What gets printed
// ---------------------------------------------------------------------------

describe('describeTarget', () => {
  it('never prints the password', () => {
    const target = resolveDevTarget(env({ SUPABASE_DB_PASSWORD: 'super-secret-value' }));
    const text = describeTarget(target).join('\n');
    assert.ok(!text.includes('super-secret-value'));
    assert.ok(!text.toLowerCase().includes('password'));
  });

  it('states which route will be used, so a dry run shows it', () => {
    const direct = describeTarget(resolveDevTarget(env())).join('\n');
    assert.match(direct, /route\s*:\s*direct/);
    assert.match(direct, new RegExp(`db\\.${DEV_REF}\\.supabase\\.co`));

    const pooled = describeTarget(
      resolveDevTarget(env({ SUPABASE_DB_POOLER_HOST: 'aws-0-eu-west-1.pooler.supabase.com' }))
    ).join('\n');
    assert.match(pooled, /route\s*:\s*pooler/);
    assert.match(pooled, /aws-0-eu-west-1\.pooler\.supabase\.com/);
  });

  it('shows the ref that passed the check', () => {
    const text = describeTarget(resolveDevTarget(env())).join('\n');
    assert.match(text, new RegExp(`project ref\\s*:\\s*${DEV_REF}`));
  });
});
