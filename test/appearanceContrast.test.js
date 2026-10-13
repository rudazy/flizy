/**
 * Each background preset has to stay readable. AA is 4.5 for these text pairs.
 *
 * Run: node --test test/appearanceContrast.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'web', 'app', 'globals.css'), 'utf8');
const MESSAGES = fs.readFileSync(path.join(__dirname, '..', 'web', 'lib', 'i18n', 'messages.ts'), 'utf8');

describe('background preset contrast', () => {
  it('keeps body, secondary, button, nav and accent at AA', async () => {
    const theme = await import('../web/lib/appearance.ts');
    assert.equal(theme.PRESETS.length, 5);
    const failures = [];
    for (const preset of theme.PRESETS) {
      for (const pair of theme.contrastPairs(preset)) {
        const ratio = theme.contrastRatio(pair.fg, pair.bg);
        if (ratio < pair.min) {
          failures.push(`${preset.id} ${pair.name} ${ratio.toFixed(2)} ${pair.fg} on ${pair.bg}`);
        }
      }
      assert.equal(CSS.includes(preset.bg), true, `${preset.id} background`);
      assert.equal(CSS.includes(`data-flizy-preset='${preset.id}'`), true, preset.id);
      assert.equal(preset.accent.toLowerCase().startsWith('#'), true);
    }
    assert.deepEqual(failures, []);
  });

  it('does not use a blue channel as the dominant hue', async () => {
    const theme = await import('../web/lib/appearance.ts');
    for (const preset of theme.PRESETS) {
      for (const hex of [preset.bg, preset.surface, preset.text, preset.accent, preset.navBg]) {
        const raw = hex.replace('#', '');
        const r = parseInt(raw.slice(0, 2), 16);
        const g = parseInt(raw.slice(2, 4), 16);
        const b = parseInt(raw.slice(4, 6), 16);
        assert.ok(b <= Math.max(r, g) + 8, `${preset.id} ${hex} leans blue`);
      }
    }
  });

  it('says the background is private in en, ko and zh', () => {
    const hints = [
      'Only you can see your background.',
      '배경은 본인만 볼 수 있습니다.',
      '只有你能看到自己的背景。',
    ];
    for (const hint of hints) {
      const line = MESSAGES.split('\n').find((row) => row.includes(hint));
      assert.ok(line, hint);
      assert.equal(line.includes('\u2014'), false, hint);
      assert.equal(line.includes('\u2013'), false, hint);
    }
  });
});
