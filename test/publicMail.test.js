/**
 * The four public mailboxes.
 *
 * support is account help, admin is business, contact is general, privacy is
 * data requests. They are named once in web/lib/publicMail.ts. Pages render
 * that list. llms.txt is static, so it is checked against the same list.
 *
 * Run: node --test test/publicMail.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(WEB, ...p), 'utf8');

const EXPECTED = [
  ['support', 'support@flizy.app', /Account help/, 'customer support'],
  ['admin', 'admin@flizy.app', /Business/, 'business'],
  ['contact', 'contact@flizy.app', /General/, 'general'],
  ['privacy', 'privacy@flizy.app', /Privacy and data requests/, 'privacy'],
];

let mail;

before(async () => {
  mail = await import('../web/lib/publicMail.ts');
});

function walkSources() {
  const out = [];
  const skip = new Set(['node_modules', '.next']);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/.test(entry.name)) continue;
      out.push([path.relative(WEB, full).replace(/\\/g, '/'), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(WEB);
  return out;
}

describe('the mailboxes are one list', () => {
  it('names the four addresses in order, each with one job', () => {
    assert.deepEqual(
      mail.PUBLIC_MAIL.map((box) => box.id),
      EXPECTED.map((row) => row[0])
    );
    for (const [id, address, use, contactType] of EXPECTED) {
      const box = mail.publicMail(id);
      assert.equal(box.address, address);
      assert.match(box.use, use);
      assert.equal(box.contactType, contactType);
      assert.doesNotMatch(box.use, /alias|inbox|Nigeria|\bRC\b/i);
    }
  });

  it('refuses an unknown id', () => {
    assert.throws(() => mail.publicMail('billing'), /Unknown public mailbox/);
  });
});

describe('pages render the list instead of retyping an address', () => {
  const pages = [
    ['components/SiteFooter.tsx', false],
    ['components/PublicMailList.tsx', true],
    ['app/terms/page.tsx', false],
    ['app/privacy/page.tsx', false],
    ['components/JsonLd.tsx', false],
  ];

  it('the list component is the only place a page would print an address', () => {
    for (const [file] of pages) {
      if (file === 'components/PublicMailList.tsx') continue;
      const src = read(...file.split('/'));
      assert.match(src, /PublicMailList|PUBLIC_MAIL|publicMail\(/, `${file} does not use the mailbox list`);
    }
    const list = read('components', 'PublicMailList.tsx');
    assert.match(list, /mailto:\$\{box\.address\}/);
    assert.match(list, /PUBLIC_MAIL\.filter/);
    assert.match(read('components', 'SiteFooter.tsx'), /ids=\{\['contact'\]\}/);
  });

  it('does not hardcode a flizy.app mailbox outside the list', () => {
    const allowed = new Set(['lib/publicMail.ts']);
    for (const [name, src] of walkSources()) {
      if (allowed.has(name)) continue;
      assert.doesNotMatch(src, /[a-z0-9._+-]+@flizy\.app/i, `${name} hardcodes a mailbox`);
    }
  });

  it('gives privacy its address and terms the support address', () => {
    const privacy = read('app', 'privacy', 'page.tsx');
    const terms = read('app', 'terms', 'page.tsx');
    assert.match(privacy, /publicMail\('privacy'\)/);
    assert.match(privacy, /mailto:\$\{privacyBox\.address\}/);
    assert.match(privacy, /id="delete"/);
    assert.match(privacy, /ids=\{\['privacy'\]\}/);
    assert.doesNotMatch(privacy, /ids=\{\['(support|admin|contact)'\]\}/);
    assert.match(terms, /ids=\{\['support'\]\}/);
    assert.doesNotMatch(terms, /ids=\{\['(privacy|admin|contact)'\]\}/);
  });

  it('publishes every mailbox in the Organization schema, with contact as the general email', () => {
    const src = read('components', 'JsonLd.tsx');
    assert.match(src, /email: publicMail\('contact'\)\.address/);
    assert.match(src, /contactPoint: PUBLIC_MAIL\.map/);
    assert.doesNotMatch(src, /addressCountry|areaServed/);
  });
});

describe('llms.txt matches the list', () => {
  it('states each address and its job', () => {
    const text = read('public', 'llms.txt');
    for (const box of mail.PUBLIC_MAIL) {
      assert.ok(text.includes(`${box.address} : ${box.use}`), `llms.txt is missing ${box.address}`);
    }
  });
});
