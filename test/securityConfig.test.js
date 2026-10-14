/**
 * The bots say at startup when a chat money protection is switched off in
 * their .env, and report it to Sentry in production under the alert tag the
 * existing rule listens on.
 *
 * REQUIRE_UNLOCK sat at false on the production host with nothing noticing.
 * The template the host was set up from shipped it that way.
 *
 * Run: node --test test/securityConfig.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { unsafeSecuritySettings, checkSecuritySettings } = require('../lib/securityConfig');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SAFE = { requireUnlock: true, enforceTrusted: true };
const SAFE_ENV = { SECURITY_MAIL_SECRET: 'x'.repeat(40), NODE_ENV: 'production' };

describe('unsafeSecuritySettings', () => {
  it('finds nothing when every protection is on', () => {
    assert.deepEqual(unsafeSecuritySettings(SAFE, SAFE_ENV), []);
  });

  it('names each switch that is off', () => {
    assert.match(unsafeSecuritySettings({ ...SAFE, requireUnlock: false }, SAFE_ENV).join('\n'), /REQUIRE_UNLOCK is off/);
    assert.match(unsafeSecuritySettings({ ...SAFE, enforceTrusted: false }, SAFE_ENV).join('\n'), /ENFORCE_TRUSTED is off/);
    assert.match(
      unsafeSecuritySettings(SAFE, { ...SAFE_ENV, SECURITY_MAIL_SECRET: '  ' }).join('\n'),
      /SECURITY_MAIL_SECRET is not set/
    );
    assert.equal(unsafeSecuritySettings({ requireUnlock: false, enforceTrusted: false }, {}).length, 3);
  });

  it('reads the real config, where only the literal false switches a protection off', () => {
    const { config } = require('../lib/config');
    assert.equal(typeof config.requireUnlock, 'boolean');
    assert.equal(typeof config.enforceTrusted, 'boolean');
  });
});

describe('checkSecuritySettings', () => {
  function run(cfg, env) {
    const warned = [];
    const reported = [];
    const found = checkSecuritySettings({
      service: 'flizy-test',
      warn: (m) => warned.push(m),
      report: (m) => reported.push(m),
      cfg,
      env,
    });
    return { found, warned, reported };
  }

  it('reports to Sentry in production', () => {
    const r = run({ ...SAFE, requireUnlock: false }, SAFE_ENV);
    assert.equal(r.found, true);
    assert.equal(r.reported.length, 1);
    assert.match(r.reported[0], /^SECURITY CONFIG: flizy-test started with protections off\./);
    assert.match(r.reported[0], /REQUIRE_UNLOCK is off/);
  });

  it('only logs outside production', () => {
    const r = run({ ...SAFE, enforceTrusted: false }, { ...SAFE_ENV, NODE_ENV: 'development' });
    assert.equal(r.warned.length, 1);
    assert.equal(r.reported.length, 0);
  });

  it('is silent when everything is on', () => {
    const r = run(SAFE, SAFE_ENV);
    assert.deepEqual(r, { found: false, warned: [], reported: [] });
  });
});

describe('wiring', () => {
  it('both bots run the check at boot, right after the schema check', () => {
    for (const [file, service] of [['index.js', 'flizy-whatsapp'], ['telegram.js', 'flizy-telegram']]) {
      const src = read(file);
      const schema = src.indexOf('await assertSchema();');
      const check = src.indexOf(`checkSecurityConfig('${service}');`);
      assert.ok(schema > 0 && check > schema, file);
    }
  });

  it('reports under alert=schema_exposure with its own fingerprint', () => {
    const src = read('lib/sentry.js');
    const fn = src.slice(src.indexOf('function reportSecurityConfig'), src.indexOf('module.exports'));
    assert.match(fn, /tags: \{ alert: EXPOSURE_ALERT_TAG \}/);
    assert.match(fn, /fingerprint: \[EXPOSURE_ALERT_TAG, 'security_config'\]/);
    assert.match(read('lib/runtime.js'), /checkSecuritySettings\(\{ service, warn: console\.error, report: reportSecurityConfig \}\)/);
  });

  it('the env templates ship the protections on', () => {
    for (const file of ['.env.example', '.env.dev.example']) {
      const src = read(file);
      assert.match(src, /^REQUIRE_UNLOCK=true\r?$/m, file);
      assert.match(src, /^ENFORCE_TRUSTED=true\r?$/m, file);
      assert.doesNotMatch(src, /^REQUIRE_UNLOCK=false/m, file);
    }
  });
});
