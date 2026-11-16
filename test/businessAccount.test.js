/**
 * Business accounts (Phase 0e, part 2): the terms (web/lib/businessTerms.ts),
 * the switch (/api/account/business), the panel and the migration.
 *
 * Covers: the terms are plain, one point per line, name the 1% that the fee
 * settings charge, and carry a version; turning Business on takes the current
 * terms version and records when, and is refused on stale terms; turning it
 * off is plain; a database without the columns answers "not available yet";
 * the panel only turns it on once the terms are agreed and asks before
 * turning it off; and a business always has the terms it accepted.
 *
 * Run: node --test test/businessAccount.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
let T;
let fees;
before(async () => {
  T = await import('../web/lib/businessTerms.ts');
  fees = await import('../web/lib/fees.ts');
});

describe('the business terms', () => {
  it('a dated version, and the current one is the only one accepted', () => {
    assert.match(T.BUSINESS_TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(T.isCurrentBusinessTerms(T.BUSINESS_TERMS_VERSION), true);
    for (const v of ['2020-01-01', '', null, undefined, 20261116]) assert.equal(T.isCurrentBusinessTerms(v), false, String(v));
  });

  it('plain words: short points, ASCII, no dashes, and the 1% the fee settings charge', () => {
    assert.ok(T.BUSINESS_TERMS.length >= 4 && T.BUSINESS_TERMS.length <= 8);
    for (const line of T.BUSINESS_TERMS) {
      assert.ok(line.length <= 160, line);
      assert.doesNotMatch(line, /[^\x20-\x7E]/, line);
      assert.match(line, /\.$/, line);
    }
    const all = T.BUSINESS_TERMS.join(' ');
    assert.match(all, /Flizy keeps 1% of each payment you receive/);
    assert.match(all, /They pay no fee/);
    assert.match(all, /turn Business off at any time/);
    assert.match(all, /test tokens, not real money/);
    // The 1% in the terms is the default merchant fee; changing it needs new terms.
    assert.equal(fees.DEFAULTS.FEE_MERCHANT_BPS, '100');
  });
});

describe('the switch', () => {
  const route = read('web/app/api/account/business/route.ts');
  const post = route.slice(route.indexOf('export async function POST'));

  it('POST is same-origin and signed in, and needs an explicit on or off', () => {
    assert.ok(post.indexOf('rejectIfCrossOrigin(req)') < post.indexOf('getAccountIdFromCookie()'));
    assert.match(post, /if \(body\.on !== true && body\.on !== false\)/);
  });

  it('on takes the current terms, records them and when; stale terms are refused before anything is written', () => {
    const check = post.indexOf('if (body.on && !isCurrentBusinessTerms(body.termsVersion))');
    assert.ok(check > 0 && check < post.indexOf(".update(patch)"));
    assert.match(post, /\{ is_business: true, business_terms_version: BUSINESS_TERMS_VERSION, business_since: new Date\(\)\.toISOString\(\) \}/);
    assert.match(post, /: \{ is_business: false \};/);
    assert.match(post, /status: 409/);
  });

  it('only the signed-in account is changed, and a database without the columns says not available yet', () => {
    assert.match(post, /\.update\(patch\)\.eq\('id', accountId\)/);
    assert.match(route, /const NOT_READY = \{ error: 'Business accounts are not available yet\.' \};/);
    assert.equal((route.match(/if \(notReady\(error\)\) return NextResponse\.json\(NOT_READY, \{ status: 503 \}\);/g) || []).length, 2);
  });
});

describe('the panel and the page', () => {
  const panel = read('web/components/BusinessAccountPanel.tsx');

  it('turns Business on only once the terms are agreed, sending the version it showed', () => {
    assert.match(panel, /disabled=\{busy \|\| !agreed\} onClick=\{\(\) => void save\(true\)\}/);
    assert.match(panel, /\{ on: true, termsVersion: view\.terms\.version \}/);
    assert.match(panel, /I have read these terms and agree to them\./);
  });

  it('asks once more before turning it off', () => {
    assert.match(panel, /onClick=\{\(\) => setConfirmOff\(true\)\}/);
    assert.match(panel, /onClick=\{\(\) => void save\(false\)\}/);
  });

  it('is a slide on Account', () => {
    const page = read('web/app/dashboard/account/page.tsx');
    assert.match(page, /\{ id: 'business', label: 'Business' \}/);
    assert.match(page, /\{slide === 'business' \? <BusinessAccountPanel \/> : null\}/);
  });
});

describe('the migration', () => {
  const sql = read('supabase/migrations/20261116140000_business_accounts.sql');

  it('off by default, and a business always has the terms it accepted', () => {
    assert.match(sql, /add column if not exists is_business boolean not null default false/);
    assert.match(sql, /not is_business or \(business_terms_version is not null and business_since is not null\)/);
    assert.match(sql, /raise exception 'accounts_business_terms_check is missing'/);
  });
});
