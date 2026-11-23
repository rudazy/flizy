/**
 * Pay link page in every interface language: the catalog is complete and
 * keeps its placeholders, the page writes no English of its own, and a
 * visitor can pick the language on the page itself.
 *
 * Run: node --test test/payI18n.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

/** The {name} placeholders in a string, sorted, so word order may differ. */
const slots = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('pay catalog', () => {
  let P;
  let M;
  let L;
  before(async () => {
    P = await import(pathToFileURL(path.join(WEB, 'lib', 'i18n', 'pay.ts')).href);
    M = await import(pathToFileURL(path.join(WEB, 'lib', 'i18n', 'messages.ts')).href);
    L = await import(pathToFileURL(path.join(WEB, 'lib', 'locale.ts')).href);
  });

  it('is part of the main table, in every language', () => {
    const keys = Object.keys(P.payEn);
    assert.ok(keys.length > 100);
    for (const key of keys) assert.equal(M.en[key], P.payEn[key], key);
    for (const locale of L.LOCALES) {
      for (const key of keys) assert.ok(M.t(locale, key) && M.t(locale, key) !== key, `${locale} ${key}`);
    }
  });

  it('keeps every placeholder in every language', () => {
    const tables = { ko: P.payKo, zh: P.payZh, id: P.payId };
    for (const [locale, table] of Object.entries(tables)) {
      assert.deepEqual(Object.keys(table).sort(), Object.keys(P.payEn).sort(), locale);
      for (const key of Object.keys(P.payEn)) assert.deepEqual(slots(table[key]), slots(P.payEn[key]), `${locale} ${key}`);
    }
  });

  it('fills the placeholders it is given', () => {
    assert.equal(M.t('en', 'pay.reviewTo', { handle: '@ana' }), 'Review payment to @ana');
    assert.equal(M.t('id', 'pay.paidText', { amount: '1', unit: 'ETH', handle: '@ana' }), 'Anda telah mengirim 1 ETH ke @ana.');
  });

  it('inserts values exactly as given, once', () => {
    // A typed amount is shown as typed: no replacement patterns, no second fill.
    assert.equal(M.t('en', 'pay.confirm', { amount: '1$&', unit: 'ETH' }), 'Confirm and pay 1$& ETH');
    assert.equal(M.t('en', 'pay.confirm', { amount: "$'$$", unit: 'ETH' }), "Confirm and pay $'$$ ETH");
    assert.equal(M.t('en', 'pay.confirm', { amount: '{unit}', unit: 'ETH' }), 'Confirm and pay {unit} ETH');
    // A slot with no value stays visible rather than vanishing.
    assert.equal(M.t('en', 'pay.confirm', { amount: '2' }), 'Confirm and pay 2 {unit}');
  });

  it('has no long dashes in any language', () => {
    for (const table of [P.payEn, P.payKo, P.payZh, P.payId]) {
      for (const [key, text] of Object.entries(table)) assert.equal(/[\u2013\u2014]/.test(text), false, key);
    }
  });

  it('still defaults to English', () => {
    assert.equal(L.DEFAULT_LOCALE, 'en');
    assert.equal(M.t(L.normalizeLocale(undefined), 'pay.logInToPay'), 'Log in to pay');
  });
});

describe('pay page text', () => {
  /** A line of JSX text or a quoted English sentence the page writes itself. */
  const ENGLISH = /^\s+[A-Z][a-z]+(?: [A-Za-z@{}'.]+)+[.!?]?$|(?:aria-label|title|placeholder)="[A-Za-z]|'[A-Z][a-z]+ [a-z]+[^']*\.'/;

  for (const file of ['components/PayLanding.tsx', 'components/ExternalPay.tsx', 'components/ShareReceiptButton.tsx', 'components/PayNotFound.tsx']) {
    it(`${file} writes no English of its own`, () => {
      const lines = read(file)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line));
      const found = lines.filter((line) => ENGLISH.test(line) && !line.includes('Flizy Pay'));
      assert.deepEqual(found, []);
    });
  }

  it('offers the language on the page, as a real control with a 44px target', () => {
    const page = read('components/PayLanding.tsx');
    assert.match(page, /<label htmlFor="pay-locale" className="sr-only">\s*\{t\('account\.language'\)\}\s*<\/label>/);
    assert.match(page, /<LanguageSelect id="pay-locale" value=\{locale\} onChange=\{setLocale\} className="[^"]*min-h-\[44px\][^"]*" \/>/);
    // Before the card, so it is the first thing a visitor can change.
    assert.ok(page.indexOf('id="pay-locale"') < page.indexOf('{askView ? <CardArc /> : null}'));
  });

  it('says which language it is in, and lets a longer language wrap instead of clip', () => {
    const page = read('components/PayLanding.tsx');
    assert.match(page, /<div lang=\{locale\} className="fade-up mx-auto w-full max-w-\[560px\]">/);
    assert.match(read('components/PayNotFound.tsx'), /<div lang=\{locale\} /);
    // The two sign-in buttons share a row; a fixed single line clipped the icon in Indonesian at 360px.
    const signIn = page.slice(page.indexOf("href={`/login?next="), page.indexOf("{t('pay.createAccount')}"));
    assert.doesNotMatch(signIn, /whitespace-nowrap/);
    assert.equal((signIn.match(/text-center leading-tight/g) || []).length, 2);
    // Korean keeps words whole when it wraps.
    assert.match(fs.readFileSync(path.join(WEB, 'app', 'globals.css'), 'utf8'), /:lang\(ko\) \{\s*word-break: keep-all;\s*\}/);
  });

  it('both pay routes say not found in the visitor language', () => {
    for (const [rel, by] of [['app/pay/[code]/page.tsx', 'name'], ['app/pay/c/[code]/page.tsx', 'number']]) {
      const src = read(rel);
      assert.match(src, new RegExp(`if \\(!found\\) return <PayNotFound by="${by}" />;`), rel);
      assert.doesNotMatch(src, />Not found</, rel);
    }
  });
});
