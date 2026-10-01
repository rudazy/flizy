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
  // Safari), so the tap hook must call onSingle synchronously, and every
  // copy-on-tap control must go through it rather than a timer of its own.
  const fs = require('node:fs');
  const path = require('node:path');
  const web = (...p) => fs.readFileSync(path.join(__dirname, '..', 'web', ...p), 'utf8');
  const src = web('components', 'AppSection.tsx');
  const start = src.indexOf('export function useTapGesture(');
  assert.ok(start > 0, 'useTapGesture must exist');
  const end = src.indexOf('\nexport function', start + 1);
  const body = src.slice(start, end < 0 ? undefined : end);
  assert.doesNotMatch(body, /setTimeout\(/);
  assert.match(body, /onSingle\(\);/);

  const home = web('app', 'dashboard', 'page.tsx');
  assert.match(home, /const onWalletTap = useTapGesture\(/);
  assert.match(home, /aria-label=\{`Wallet address: \$\{walletValue\}/, 'screen readers hear the value');
  const wallet = web('components', 'WalletBalances.tsx');
  assert.match(wallet, /const onAddressTap = useTapGesture\(/);
  assert.doesNotMatch(wallet, /tapTimer/);
});
