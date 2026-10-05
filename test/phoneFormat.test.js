/**
 * The site composes a phone the same way chat does once a country is known.
 *
 * web/ cannot import root lib/ on Vercel, so web/lib/phoneFormat.ts mirrors
 * composePhoneE164. Same inputs, same digits, or the two identities diverge.
 *
 * Run: node --test test/phoneFormat.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../lib/phone');

const VECTORS = [
  ['234', '708 043 7343'],
  ['234', '07080437343'],
  ['234', '0708-043-7343'],
  ['+44', '7700 900123'],
  ['233', '7080437343'],
  ['1', '202 555 0100'],
  ['82', '10 1234 5678'],
  ['82', '010-1234-5678'],
  ['234', ''],
  ['', '7080437343'],
  ['234', '123'],
  ['971', '50 123 4567'],
];

describe('site and chat compose the same E.164', () => {
  let web;

  before(async () => {
    web = await import('../web/lib/phoneFormat.ts');
  });

  it('agrees on every vector', () => {
    for (const [code, local] of VECTORS) {
      assert.equal(
        web.composePhoneE164(code, local),
        bot.composePhoneE164(code, local),
        `${code} ${local}`
      );
    }
  });

  it('groups a local number without stranding the last digit', () => {
    assert.equal(web.groupPhoneLocal('7080437343'), '708 043 7343');
    assert.equal(web.groupPhoneLocal('708 043 7343'), '708 043 7343');
    assert.equal(web.groupPhoneLocal('07080437343'), '708 043 7343');
    assert.equal(web.groupPhoneLocal('123456789'), '123 456 789');
    assert.equal(web.groupPhoneLocal('12'), '12');
  });

  it('offers the same countries chat can name, one country each', () => {
    const expected = bot.callingCodeOptions().map((option) => ({
      iso: option.iso,
      name: option.name,
      dial: option.dial,
    }));
    assert.deepEqual(web.SITE_PHONE_COUNTRIES, expected);
    const isos = web.SITE_PHONE_COUNTRIES.map((country) => country.iso);
    assert.equal(new Set(isos).size, isos.length);
    const korea = web.SITE_PHONE_COUNTRIES.find((country) => country.iso === 'KR');
    assert.equal(korea && korea.dial, '82');
    assert.equal(web.countryFlag('KR'), bot.countryFlag('KR'));
    assert.equal(web.composePhoneE164('82', '10 1234 5678'), '821012345678');
    assert.ok(isos.includes('NG'));
    assert.ok(isos.includes('GH'));
    assert.ok(isos.includes('GB'));
    assert.ok(isos.length > 11);
  });

  it('stores a calling code the same way on both sides', () => {
    assert.equal(web.normalizeStoredCallingCode('234'), bot.normalizeCallingCode('234'));
    assert.equal(web.normalizeStoredCallingCode('44'), bot.normalizeCallingCode('+44'));
    assert.equal(web.normalizeStoredCallingCode('0234'), '');
    assert.equal(bot.normalizeCallingCode('0234'), '');
    assert.equal(bot.normalizeCallingCode('12345'), '');
  });
});

describe('opening page', () => {
  const page = fs.readFileSync(path.join(__dirname, '../web/app/page.tsx'), 'utf8');
  const pay = fs.readFileSync(path.join(__dirname, '../web/components/PayPeople.tsx'), 'utf8');

  it('keeps the video in the hero and teaches the phone in the pay section', () => {
    const hero = page.slice(page.indexOf('<section className="hero-grid'));
    assert.ok(hero.indexOf('<HeroVideo />') > hero.indexOf('</h1>'));
    assert.match(page, /Pay people, not addresses/);
    assert.match(page, /Send to a Flizy username or phone number/);
    assert.match(page, /<PayPeople \/>/);
    assert.match(pay, /Country code included automatically/);
    assert.match(pay, /Phone numbers must include the country code/);
    assert.match(pay, /flizy send 0\.01 ETH to /);
    assert.doesNotMatch(pay, /Recipient found/);
  });
});
