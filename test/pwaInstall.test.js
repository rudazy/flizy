/**
 * The opening page offers Install after Open guide. That button opens the
 * browser install dialog. The dashboard banner uses the same captured prompt,
 * and still only inside the app.
 *
 * Run: node --test test/pwaInstall.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const PAGE = read('web/app/page.tsx');
const BUTTON = read('web/components/InstallAppButton.tsx');
const STORE = read('web/components/pwaInstall.ts');
const BANNER = read('web/components/PwaRegister.tsx');
const CSS = read('web/app/globals.css');

describe('opening page install', () => {
  it('places Install after Open guide on the closing card', () => {
    const card = PAGE.slice(PAGE.indexOf('Ready when you are'));
    const guide = card.indexOf('Open guide');
    const install = card.indexOf('<InstallAppButton />');
    assert.ok(guide > 0);
    assert.ok(install > guide);
    assert.equal(card.indexOf('<InstallAppButton />', install + 1), -1);
  });

  it('is a button that opens the browser dialog, not a file download', () => {
    assert.match(BUTTON, /type="button"/);
    assert.match(BUTTON, />\s*Install\s*</);
    assert.match(BUTTON, /promptPwaInstall\(\)/);
    assert.doesNotMatch(BUTTON, /href=/);
    assert.doesNotMatch(BUTTON, /download=/);
    assert.match(BUTTON, /address bar/);
  });

  it('hides once the browser is already running Flizy installed', () => {
    assert.match(BUTTON, /if \(installed\) return null/);
    assert.match(CSS, /\.install-app-btn/);
    assert.match(CSS, /display-mode:\s*standalone/);
  });
});

describe('one browser install prompt', () => {
  it('catches the prompt before hydration, including after an uninstall', () => {
    const capture = read('web/lib/installCapture.ts');
    const layout = read('web/app/layout.tsx');
    assert.match(capture, /beforeinstallprompt/);
    assert.match(capture, /preventDefault\(\)/);
    assert.match(capture, /__flizyInstallPrompt=event/);
    assert.match(capture, /serviceWorker.register\('\/sw.js'\)/);
    assert.match(layout, /dangerouslySetInnerHTML=\{\{ __html: INSTALL_CAPTURE_JS \}\}/);
    assert.doesNotMatch(layout, /strategy="beforeInteractive"/);
    assert.match(STORE, /__flizyInstallPrompt/);
    assert.match(STORE, /adopt\(\)/);
    assert.match(STORE, /pending\.prompt\(\)/);
    assert.doesNotMatch(BANNER, /addEventListener\('beforeinstallprompt'/);
    assert.doesNotMatch(BUTTON, /addEventListener\('beforeinstallprompt'/);
    assert.match(BANNER, /promptPwaInstall\(\)/);
  });

  it('keeps the nag banner inside the signed-in app', () => {
    assert.match(BANNER, /pathname\.startsWith\('\/dashboard'\)/);
    assert.match(BANNER, /flizy:install-later/);
  });
});
