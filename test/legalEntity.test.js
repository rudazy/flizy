/**
 * Naming the company behind the site.
 *
 * The Terms and the Privacy policy both said "we" without ever resolving it to
 * a legal person, which weakens both: a privacy policy needs a named data
 * controller to mean anything, and terms need a named counterparty to bind
 * anyone. The footer named nobody either.
 *
 * The registration number now appears in four places, so the risk this guards
 * is drift: one of them being edited and the others left behind. Everything
 * reads from lib/entity.ts, and these tests check that it stays that way rather
 * than someone retyping the number into a page.
 *
 * Run: node --test test/legalEntity.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');

const FOOTER = read('components', 'SiteFooter.tsx');
const TERMS = read('app', 'terms', 'page.tsx');
const PRIVACY = read('app', 'privacy', 'page.tsx');
const JSONLD = read('components', 'JsonLd.tsx');

let entity;

before(async () => {
  entity = await import('../web/lib/entity.ts');
});

describe('the entity is stated once and reused', () => {
  it('carries a registered name, a registration number and a jurisdiction', () => {
    assert.match(entity.ENTITY.legalName, /\S/);
    assert.match(entity.ENTITY.rc, /^RC \d+$/);
    assert.match(entity.ENTITY.jurisdiction, /\S/);
  });

  it('keeps the prose and data forms of the number in step', () => {
    // Two spellings of one number is exactly the drift this file guards, so
    // the data form has to be derivable from the prose one.
    assert.equal(entity.ENTITY.rcNumber, entity.ENTITY.rc.replace(/^RC\s*/, ''));
    assert.match(entity.ENTITY.rcNumber, /^\d+$/);
  });

  it('builds the footer line and the document sentence from those parts', () => {
    assert.ok(entity.ENTITY_LINE.includes(entity.ENTITY.legalName));
    assert.ok(entity.ENTITY_LINE.includes(entity.ENTITY.rc));
    assert.ok(entity.ENTITY_LINE.includes(entity.ENTITY.jurisdiction));
    assert.ok(entity.ENTITY_SENTENCE.includes(entity.ENTITY.legalName));
    assert.ok(entity.ENTITY_SENTENCE.includes(entity.ENTITY.rc));
  });

  it('is never retyped into a page', () => {
    // A hardcoded number is the failure this file exists to prevent: it stays
    // right until the day the real one changes, and then it is quietly wrong
    // on a legal page.
    const number = entity.ENTITY.rc.replace(/^RC\s*/, '');
    for (const [name, src] of [
      ['footer', FOOTER],
      ['terms', TERMS],
      ['privacy', PRIVACY],
      ['json-ld', JSONLD],
    ]) {
      assert.ok(
        !src.includes(number),
        `${name} hardcodes the registration number instead of importing it`
      );
    }
  });
});

describe('it appears where people and regulators look', () => {
  it('is in the footer, as plain text rather than a link', () => {
    assert.match(FOOTER, /ENTITY_LINE/);
    assert.match(FOOTER, /\{ENTITY_LINE\}/);
    assert.ok(
      !/href=\{[^}]*ENTITY/.test(FOOTER),
      'the entity line must not be a link nobody clicks'
    );
  });

  it('names the counterparty in the Terms', () => {
    assert.match(TERMS, /ENTITY_SENTENCE/);
    assert.match(TERMS, /These terms are an agreement between you and/);
  });

  it('names the data controller in the Privacy policy', () => {
    assert.match(PRIVACY, /ENTITY_SENTENCE/);
    assert.match(PRIVACY, /data controller/);
  });

  it('resolves "we" in both documents rather than leaving it floating', () => {
    for (const [name, src] of [['terms', TERMS], ['privacy', PRIVACY]]) {
      assert.match(src, /means that company|mean that company/, `${name} never defines "we"`);
    }
  });

  it('states the legal name in the Organization schema too', () => {
    assert.match(JSONLD, /legalName: ENTITY\.legalName/);
  });

  it('publishes the registration number as data, not as a sentence', () => {
    // schema.org has no company-registration property, so PropertyValue is the
    // documented way to carry a number together with its scheme. Free text
    // gives a parser a string it cannot act on.
    assert.match(JSONLD, /'@type': 'PropertyValue'/);
    assert.match(JSONLD, /propertyID:/);
    assert.match(JSONLD, /value: ENTITY\.rcNumber/);
  });
});

describe('the documents stay reachable once signed in', () => {
  const ACCOUNT = read('app', 'dashboard', 'account', 'page.tsx');
  const CHROME = read('components', 'AppChrome.tsx');

  it('the app routes still have no footer, which is why this matters', () => {
    // Not a complaint about the design, a statement of the reason. If a footer
    // ever does render on /dashboard this test should be revisited, not deleted.
    assert.match(CHROME, /pathname\.startsWith\('\/dashboard'\)/);
  });

  it('account links to both documents', () => {
    assert.match(ACCOUNT, /href="\/terms"/);
    assert.match(ACCOUNT, /href="\/privacy"/);
  });
});

describe('no personal document is published', () => {
  it('ships no incorporation certificate or status report', () => {
    // The certificate carries a full legal name; the status report carries a
    // residential address and a date of birth. The RC number proves the same
    // thing and discloses neither.
    const publicDir = path.join(WEB, 'public');
    const files = fs.readdirSync(publicDir).map((f) => f.toLowerCase());
    for (const f of files) {
      assert.ok(
        !/(certificate|incorporation|status[-_]?report|cac)/.test(f),
        `web/public/${f} looks like a registration document`
      );
    }
  });
});

describe('the JSON-LD block cannot be broken out of', () => {
  it('escapes the angle bracket that would close the script tag', async () => {
    // JSON.stringify leaves `</script>` intact, which ends the block early and
    // turns the rest into markup. One of these graphs carries URLs from
    // NEXT_PUBLIC_ORG_SAME_AS, checked only for an http prefix.
    const { serializeJsonLd } = await import('../web/lib/jsonLd.ts');
    const payload = 'https://x.com/a</script><script>alert(1)</script>';
    const out = serializeJsonLd({ sameAs: [payload] });

    assert.ok(!out.includes('</script>'), 'the payload still closes the script block');
    // Escaped, not mangled: a consumer still reads the original string back.
    assert.equal(JSON.parse(out).sameAs[0], payload);
  });

  it('leaves ordinary data untouched', () => {
    // Regression guard on the escape itself. If it ever grew broader it would
    // start corrupting the structured data it exists to protect.
    const { serializeJsonLd } = require('../web/lib/jsonLd.ts');
    const graph = { name: 'Flizy', legalName: 'Flizy Tek Ltd', identifier: 'RC 9864520' };
    assert.deepEqual(JSON.parse(serializeJsonLd(graph)), graph);
  });

  it('both emitters use it, not just one', () => {
    for (const f of ['StructuredData.tsx', 'JsonLd.tsx']) {
      const src = read('components', f);
      assert.match(src, /serializeJsonLd\(/, `${f} still stringifies directly`);
      assert.ok(
        !/__html: JSON\.stringify\(/.test(src),
        `${f} embeds raw JSON.stringify output`
      );
    }
  });

  it('is the only thing either component embeds', () => {
    // Catches a third emitter being added later that goes straight to
    // JSON.stringify and quietly reopens the hole.
    const all = ['StructuredData.tsx', 'JsonLd.tsx'].map((f) => read('components', f)).join('\n');
    const embeds = all.match(/__html:\s*[A-Za-z_$][\w$]*\(/g) || [];
    for (const e of embeds) {
      assert.match(e, /serializeJsonLd\(/, `unexpected embedder: ${e}`);
    }
  });
});
