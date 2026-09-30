const { test } = require('node:test');
const assert = require('node:assert/strict');

test('a second press inside the window is a double tap', async () => {
  const { classifyTap, TAP_WINDOW_MS } = await import('../web/lib/tapGesture.ts');
  assert.equal(classifyTap(0), 'double');
  assert.equal(classifyTap(TAP_WINDOW_MS - 1), 'double');
  assert.equal(classifyTap(TAP_WINDOW_MS), 'pending');
  assert.equal(classifyTap(1000), 'pending');
  assert.equal(classifyTap(-1), 'pending');
});

test('the single-tap action runs inside the tap, not on a timer', () => {
  // A clipboard write deferred past the user gesture can be refused (iOS
  // Safari), so the status tap must call onSingle synchronously.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'components', 'AppSection.tsx'), 'utf8');
  const start = src.indexOf('export function AppStatusTap(');
  assert.ok(start > 0, 'AppStatusTap must exist');
  const end = src.indexOf('\nexport function', start + 1);
  const body = src.slice(start, end < 0 ? undefined : end);
  assert.doesNotMatch(body, /setTimeout\(/);
  assert.match(body, /onSingle\(\);/);
  assert.match(body, /aria-label=\{`\$\{label\}: \$\{value\}/, 'screen readers hear the value');
});
