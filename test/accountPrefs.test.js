/**
 * Account Pay me, Language and Country slides: what they may offer and print.
 *
 * Run: node --test test/accountPrefs.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const PAY = read('components/PayIdentity.tsx');
const PREFS = read('components/AccountPrefs.tsx');
const PAGE = read('app/dashboard/account/page.tsx');

describe('Pay me', () => {
  it('prints the QR and the Flizy number only, never the username or the link', () => {
    assert.match(PAY, /<div className="relative grid gap-3 sm:grid-cols-2 print:hidden">\s*\{username \? <Field label="Username"/);
    assert.match(PAY, /<div className="print:hidden">\s*<PrefHero/);
    assert.match(PAY, /print:bg-white/);
  });

  it('the QR still encodes the permanent code link, not the username link', () => {
    assert.match(PAY, /QR\.toCanvas\(canvas, qrUrl,/);
    assert.match(PAGE, /<PayIdentity url=\{data\.pay\.url\} qrUrl=\{data\.pay\.qrUrl\} code=\{data\.pay\.code\} username=\{data\.pay\.username\} \/>/);
  });
});

describe('Language', () => {
  it('offers only the languages the site is translated into', () => {
    assert.match(PREFS, /\{LOCALES\.map\(\(code\) =>/);
    const face = /const LANGUAGE_FACE: Record<LocaleCode, \{ iso: string; english: string \}> = \{([\s\S]*?)\};/.exec(PREFS);
    assert.ok(face, 'LANGUAGE_FACE');
    assert.deepEqual([...face[1].matchAll(/^\s*([a-z]{2}):/gm)].map((m) => m[1]), ['en', 'ko', 'zh']);
  });

  it('every new label is translated in every locale', () => {
    const messages = read('lib/i18n/messages.ts');
    for (const key of ['account.preferences', 'account.languageCurrent']) {
      assert.equal(messages.split(`'${key}':`).length - 1, 3, key);
    }
  });
});

describe('Country', () => {
  it('lists every supported country, searchable, with no default first', () => {
    assert.match(PREFS, /\[\.\.\.\(query\.trim\(\) \? \[\] : \[null\]\), \.\.\.SITE_PHONE_COUNTRIES\.filter\(\(c\) => matches\(c, query\)\)\]/);
    assert.match(PREFS, /role="listbox"/);
    assert.match(PREFS, /aria-activedescendant=/);
  });

  it('saves through the existing calling code route', () => {
    assert.match(PAGE, /onSave=\{\(\) => void setDefaultCallingCode\(countryIso\)\}/);
  });
});

describe('Art', () => {
  it('the hero art ships with the site', () => {
    for (const f of ['language-globe.webp', 'country-globe.webp']) {
      const file = path.join(WEB, 'public', 'account', f);
      assert.ok(fs.existsSync(file), f);
      assert.ok(fs.statSync(file).size < 60_000, `${f} is small`);
    }
  });
});
