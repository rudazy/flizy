/**
 * Account, Projects: the list and Create a Project follow the phone layout
 * without promising anything a project row cannot hold.
 *
 * Run: node --test test/accountProjectsUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'web/components/AccountProjects.tsx'), 'utf8');
const CSP = fs.readFileSync(path.join(ROOT, 'web/lib/contentSecurityPolicy.mjs'), 'utf8');

// Comments are stripped first, so the header that explains a rule cannot trip it.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const CODE = stripComments(SRC);

function imgSrc() {
  const found = CSP.match(/"img-src ([^"]+)"/);
  assert.ok(found, 'img-src directive not found');
  return found[1];
}

describe('account projects layout', () => {
  it('carries the sections of the list and the create screen', () => {
    for (const label of [
      'Workspace',
      'No projects yet',
      'Create project',
      'Custom page',
      'Create tasks',
      'New project',
      'Basic information',
      'Picture and banner',
      'Profile picture',
      'Square image (1:1)',
      'Banner image',
      'Recommended 16:9',
      'Upload image',
      'Upload banner',
      'PNG, JPG or WebP',
      'Max 2 MB',
      'Continue',
      'Cancel',
    ]) {
      assert.ok(CODE.includes(label), label);
    }
    assert.match(CODE, /My <span className="text-sun">Projects<\/span>/);
    assert.match(CODE, /Create a <span className="text-sun">Project<\/span>/);
    assert.match(CODE, /\['Details', 'Team', 'Links', 'Settings', 'Review'\]/);
    assert.equal(SRC.includes(String.fromCharCode(0x2014)), false);
  });

  it('ships every illustration it points at, and nothing else in that folder', () => {
    const used = [...new Set([...CODE.matchAll(/\/projects\/([a-z-]+\.webp)/g)].map((m) => m[1]))].sort();
    const files = fs.readdirSync(path.join(ROOT, 'web/public/projects')).sort();
    assert.deepEqual(used, files);
  });
});

describe('account projects honesty', () => {
  it('posts only the columns a project has, the picture included', () => {
    const body = CODE.match(/body: JSON\.stringify\(\{([\s\S]*?)\}\),/);
    assert.ok(body, 'create body not found');
    const keys = [...body[1].matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(keys, ['description', 'handle', 'image', 'links', 'name']);
  });

  it('keeps Verified unselected and says how verification happens', () => {
    assert.equal(CODE.match(/aria-checked="true"/g).length, 1);
    assert.match(CODE, /aria-checked="false"/);
    assert.match(CODE, /stays Standard until Flizy confirms it/);
    assert.match(CODE, /publicMail\('contact'\)/);
  });

  it('states the task rules instead of offering controls for them', () => {
    assert.match(CODE, /There is no participant cap\./);
    assert.match(CODE, /stays open until the deadline on that task/);
  });

  it('does not promise a featured slot, growth figures, or a saved banner', () => {
    assert.doesNotMatch(CODE, /get featured/i);
    assert.doesNotMatch(CODE, /Track growth/);
    assert.match(CODE, /The banner is shown on the preview, not saved yet\./);
    assert.match(CODE, /A banner is not saved on that page yet\./);
  });

  it('marks the handle with a link, not the payment @', () => {
    assert.match(CODE, /<FieldIcon>\s*<ChainIcon size=\{\d+\} \/>\s*<\/FieldIcon>\s*<input\s+id="project-handle"/);
    assert.match(CODE, /flizy\.app\/project\/\{shownHandle \|\| 'handle'\}/);
  });
});

describe('image previews under the content security policy', () => {
  it('reads a picked image into a data URL, which img-src allows', () => {
    assert.match(imgSrc(), /(^|\s)data:(\s|$)/);
    assert.match(CODE, /readAsDataURL\(file\)/);
    assert.match(CODE, /url\.startsWith\('data:image\/'\)/);
  });

  it('builds no object URL while img-src leaves out blob:', () => {
    // If blob: is ever allowed, revisit this test rather than deleting it.
    assert.equal(/(^|\s)blob:/.test(imgSrc()), false);
    assert.doesNotMatch(CODE, /createObjectURL/);
  });

  it('the object URL check sees a real call and ignores a comment', () => {
    assert.match(stripComments('const url = URL.createObjectURL(file);'), /createObjectURL/);
    assert.doesNotMatch(stripComments('// createObjectURL would be blocked here'), /createObjectURL/);
  });
});
