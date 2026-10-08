/**
 * Account PIN, Limits and Security slides: what each asks for, and what they
 * do not offer.
 *
 * Run: node --test test/accountSecurity.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const SEC = read('components/AccountSecurity.tsx');
const PAGE = read('app/dashboard/account/page.tsx');
const PROVIDER = read('components/DashboardProvider.tsx');

describe('PIN', () => {
  it('checks the PIN and the confirmation before asking for the password', () => {
    assert.match(SEC, /const PIN = \/\^\\d\{4,12\}\$\/;/);
    assert.match(SEC, /if \(again !== pin\) return 'The two PINs do not match\.';/);
    assert.match(SEC, /const why = check\(\);\s*setProblem\(why\);\s*if \(!why\) \{\s*setRefused\(false\);\s*setAsking\(true\);/);
  });

  it('the account password is asked for in the sheet, not on the form', () => {
    assert.match(SEC, /\{asking \? \(\s*<PasswordSheet/);
    const form = SEC.slice(SEC.indexOf('export function PinPanel'), SEC.indexOf('{asking ? ('));
    assert.doesNotMatch(form, /SecretInput/);
    assert.match(PAGE, /<PinPanel hasPin=\{Boolean\(data\.account\.has_pin\)\} onSave=\{onPin\}/);
  });

  it('only digits reach the PIN fields', () => {
    assert.match(SEC, /onChange=\{\(e\) => onChange\(e\.target\.value\.replace\(\/\\D\/g, ''\)\)\}/);
  });
});

describe('Limits', () => {
  it('refuses a bad number before asking for the password', () => {
    assert.match(SEC, /if \(raw !== '' && \(!\/\^\(\\d\+\(\\\.\\d\*\)\?\|\\\.\\d\+\)\$\/\.test\(raw\) \|\| !Number\.isFinite\(limit\)\)\) \{/);
    assert.match(SEC, /setProblem\(''\);\s*setRefused\(false\);\s*setPending\(limit\);/);
  });

  it('the account password is asked for in the sheet, then the limit is saved with it', () => {
    assert.match(SEC, /\{pending !== undefined \? \(\s*<PasswordSheet/);
    assert.match(SEC, /const ok = await onSave\(pending, password\);/);
    const form = SEC.slice(SEC.indexOf('export function LimitsPanel'), SEC.indexOf('{pending !== undefined ? ('));
    assert.doesNotMatch(form, /SecretInput/);
    assert.match(PAGE, /<LimitsPanel current=\{currentLimit\} onSave=\{setDailyLimit\} busy=\{busy === 'limit'\} lastError=\{msg\} \/>/);
  });
});

describe('Security', () => {
  it('offers no control for features that do not exist', () => {
    // Two-step verification and session management do not exist yet: status only.
    assert.equal((SEC.match(/status="Not available yet"/g) || []).length, 2);
  });

  it('Change on the password row opens the change sheet', () => {
    assert.match(SEC, /onClick=\{\(\) => setChanging\(true\)\}\s*aria-haspopup="dialog"/);
    assert.match(SEC, /\{changing \? \(\s*<ChangePasswordSheet/);
    // Checked against the signup rules, matched, and different, before it is sent.
    assert.match(SEC, /const rule = validatePassword\(next\);\s*if \(!rule\.ok\) return setError\(rule\.error\);\s*if \(again !== next\)/);
    assert.match(PAGE, /fetch\('\/api\/account\/password', \{\s*method: 'POST'/);
  });

  it('keeps the legal links and sign out', () => {
    for (const href of ['/docs', '/terms', '/privacy']) assert.ok(SEC.includes(`href="${href}"`), href);
    assert.match(PAGE, /onSignOut=\{\(\) => void onSignOut\(\)\}/);
  });
});

describe('POST /api/account/password', () => {
  const ROUTE_SRC = read('app/api/account/password/route.ts');

  it('same-origin and signed-in only, and the current password goes through the lockout gate', () => {
    const order = ['rejectIfCrossOrigin(req)', 'getAccountIdFromCookie()', 'validatePassword(next)', "requirePassword(supabase, accountId, current, 'change your password')", 'hashPassword(next)'];
    let at = -1;
    for (const step of order) {
      const i = ROUTE_SRC.indexOf(step);
      assert.ok(i > at, `${step} out of order`);
      at = i;
    }
  });

  it('caps the current password before any hashing', () => {
    assert.ok(ROUTE_SRC.indexOf('current.length > 256') < ROUTE_SRC.indexOf('requirePassword('));
  });

  it('refuses keeping the same password', () => {
    assert.match(ROUTE_SRC, /if \(next === current\) \{/);
  });

  it('signs out every other session and renews this one, and says so honestly', () => {
    assert.match(ROUTE_SRC, /await revokeAllSessions\(accountId\);/);
    assert.match(ROUTE_SRC, /if \(signedOutElsewhere\) \{\s*try \{\s*await createSession\(accountId\);/);
    assert.match(ROUTE_SRC, /NextResponse\.json\(\{ ok: true, signedOutElsewhere, stillSignedIn \}\)/);
  });
});

describe('Saving is quick', () => {
  it('PIN, limit and trusted wallets refresh only the account row', () => {
    for (const name of ['setUnlockPin', 'setDailyLimit', 'addTrusted', 'removeTrusted']) {
      const start = PROVIDER.indexOf(`const ${name} = useCallback(`);
      const block = PROVIDER.slice(start, PROVIDER.indexOf('\n  );\n', start));
      assert.match(block, /await loadAccount\(\);/, name);
      assert.doesNotMatch(block, /await load\(\);/, name);
    }
  });
});
