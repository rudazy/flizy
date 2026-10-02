/**
 * Landing hero video: the launch video in the column beside the headline.
 * Silent, respects reduced motion, and only on the landing page.
 *
 * The component needs a browser to render, so this reads its source, the same
 * way test/homeUi does.
 *
 * Run: node --test test/heroVideo.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'web');
const HERO = fs.readFileSync(path.join(WEB, 'components', 'HeroVideo.tsx'), 'utf8');
const LANDING = fs.readFileSync(path.join(WEB, 'app', 'page.tsx'), 'utf8');

describe('HeroVideo', () => {
  it('plays muted and inline, and loops only when it autoplays', () => {
    assert.match(HERO, /\bmuted\b/);
    assert.match(HERO, /\bplaysInline\b/);
    assert.ok(HERO.includes('loop={animate === true}'));
    assert.ok(HERO.includes('autoPlay={animate === true}'));
  });

  it('has an accessible name', () => {
    assert.match(HERO, /aria-label="[^"]+"/);
  });

  it('gives reduced motion the poster and controls, without fetching the clip', () => {
    assert.match(HERO, /prefers-reduced-motion: reduce/);
    assert.ok(HERO.includes('controls={animate === false}'));
    assert.ok(HERO.includes("preload={animate ? 'auto' : 'none'}"));
  });

  it('turns off the long-press menu, preview, download, picture-in-picture and cast', () => {
    assert.ok(HERO.includes('onContextMenu={(event) => event.preventDefault()}'));
    assert.ok(HERO.includes('[-webkit-touch-callout:none]'));
    assert.ok(HERO.includes('controlsList="nodownload noremoteplayback"'));
    assert.match(HERO, /\bdisablePictureInPicture\b/);
    assert.match(HERO, /\bdisableRemotePlayback\b/);
  });

  it('points at files that exist in public/', () => {
    for (const file of ['hero/flizy-demo.mp4', 'hero/flizy-demo-poster.jpg']) {
      assert.ok(HERO.includes(`/${file}`), `${file} is not referenced`);
      assert.ok(fs.existsSync(path.join(WEB, 'public', file)), `${file} is missing`);
    }
  });

  it('serves the clip under a site name, not the tool that made it', () => {
    assert.doesNotMatch(HERO, /brag/i);
    assert.equal(fs.readdirSync(path.join(WEB, 'public', 'hero')).some((f) => /brag/i.test(f)), false);
  });
});

describe('landing page', () => {
  it('renders the video inside the hero section', () => {
    const hero = LANDING.slice(LANDING.indexOf('<section className="hero-grid'));
    assert.ok(hero.indexOf('<HeroVideo />') > 0);
    assert.ok(hero.indexOf('<HeroVideo />') < hero.indexOf('</section>'));
    // Second column on large screens, after the headline everywhere else.
    assert.ok(LANDING.includes('lg:grid-cols-['));
    assert.ok(hero.indexOf('<HeroVideo />') > hero.indexOf('</h1>'));
  });

  it('is the only page that uses it', () => {
    const users = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('<HeroVideo')) {
          users.push(path.relative(WEB, full).split(path.sep).join('/'));
        }
      }
    };
    walk(path.join(WEB, 'app'));
    assert.deepEqual(users, ['app/page.tsx']);
  });
});
