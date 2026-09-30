/**
 * Explore, Tasks: every tab, chip and slide opens something, and the artwork
 * the page points at is there.
 *
 * The page is a client component that needs a browser to render, so this reads
 * its source and the files it depends on, the same way test/walletHistorySlide
 * does for the bottom bar.
 *
 * Run: node --test test/exploreTasksUi.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const PAGE = read('app/dashboard/explore/page.tsx');

/** Width and height from a PNG header. */
function pngSize(rel) {
  const b = fs.readFileSync(path.join(WEB, rel));
  assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a', `${rel} is not a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe('Explore Tasks artwork', () => {
  it('ships both images the page renders, at the size it draws them from', () => {
    for (const [rel, size] of [
      ['public/explore/tasks-hero.png', [338, 394]],
      ['public/explore/tasks-empty.png', [300, 235]],
    ]) {
      assert.deepEqual(pngSize(rel), size, rel);
      assert.ok(PAGE.includes(rel.replace('public', '')), `${rel} is not referenced by the page`);
    }
  });
});

describe('every control opens something', () => {
  it('has Live, Ended and My tasks, each selectable', () => {
    assert.match(PAGE, /label="Live" active=\{list === 'live'\} onClick=\{\(\) => setList\('live'\)\}/);
    assert.match(PAGE, /label="Ended" active=\{list === 'ended'\} onClick=\{\(\) => setList\('ended'\)\}/);
    assert.match(PAGE, /label="My tasks" active=\{list === 'mine'\} onClick=\{\(\) => setList\('mine'\)\}/);
    assert.match(PAGE, /list === 'mine' \? <ComingSoonPanel what="My tasks" \/>/);
  });

  it('lets every category chip be chosen, and the rest open Coming soon', () => {
    for (const label of ['All', 'Airdrop', 'Social', 'On-chain', 'Content', 'Partner']) {
      assert.match(PAGE, new RegExp(`label: '${label}'`), `${label} chip is missing`);
    }
    assert.match(PAGE, /onClick=\{\(\) => setCategory\(c\.id\)\}/);
    assert.match(PAGE, /category !== 'all' \? \(\s*<ComingSoonPanel/);
  });

  it('opens each of the four hero slides from its dot', () => {
    assert.match(PAGE, /const HERO_SLIDES = 4;/);
    assert.match(PAGE, /onClick=\{\(\) => setSlide\(i\)\}/);
    assert.match(PAGE, /slide === 0 \?/);
  });
});

describe('small controls keep a 44px tap area', () => {
  const css = read('app/globals.css');

  it('defines the tap-area classes', () => {
    assert.match(css, /\.hit-44::after \{\s*width: max\(100%, 44px\);\s*height: max\(100%, 44px\);/);
    assert.match(css, /\.hit-y-44::after \{\s*width: 100%;\s*height: max\(100%, 44px\);/);
  });

  it('uses them on the controls drawn under 44px', () => {
    assert.ok((PAGE.match(/hit-y-44/g) || []).length >= 7, 'Explore controls lost their tap area');
    assert.match(read('components/AppTopBar.tsx'), /hit-44 flex h-\[34px\] w-\[34px\]/);
    assert.match(read('components/AppSection.tsx'), /hit-y-44 flex h-\[35px\]/);
  });
});
