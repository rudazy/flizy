/**
 * Nothing the app needs may be gitignored.
 *
 * A bare directory pattern in `.gitignore` matches at any depth, so ignoring a
 * private `tasks/` directory that way also swallows `web/app/api/tasks/` and
 * `web/app/tasks/`. Every local build passes, because the files are on disk,
 * and the deploy ships without them, with nothing in the diff to explain why.
 * The root rule is therefore anchored (`/tasks/`).
 *
 * That failure is invisible to a type check, a test run and a production build,
 * which is exactly the kind worth a guard. It asks git directly rather than
 * reimplementing pattern matching, because a second implementation of git's
 * rules could hold the same misunderstanding as the pattern it checks.
 *
 * Run: node --test test/shippableFiles.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** Source directories whose contents must all reach the remote. */
const MUST_SHIP = [
  'web/app',
  'web/components',
  'web/lib',
  'lib',
  'supabase/migrations',
  'scripts',
  'test',
];

/** Extensions that are actually code or schema, rather than local noise. */
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|sql|css)$/;

/** Every code file under a directory, recursively. */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'generated') {
        continue;
      }
      walk(full, out);
      continue;
    }
    if (CODE.test(entry.name)) out.push(full);
  }
  return out;
}

describe('every source file is shippable', () => {
  it('git ignores none of it', () => {
    const files = MUST_SHIP.flatMap((d) => walk(path.join(ROOT, d))).map((f) =>
      path.relative(ROOT, f).split(path.sep).join('/')
    );
    assert.ok(files.length > 50, `expected to find source files, found ${files.length}`);

    // check-ignore exits 1 when nothing matches, which is the good case, and
    // prints one line per ignored path otherwise.
    let ignored = '';
    try {
      ignored = execFileSync('git', ['check-ignore', '--stdin'], {
        cwd: ROOT,
        input: files.join('\n'),
        encoding: 'utf8',
      });
    } catch (err) {
      if (err.status !== 1) throw err;
      ignored = String(err.stdout || '');
    }

    const hits = ignored.split('\n').map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(hits, [], 'these source files would never reach the remote');
  });

  it('still ignores the private notes directory at the root', () => {
    // Anchored, not deleted. If this fails, the anchor was removed along with
    // the protection.
    for (const p of ['tasks/example.md']) {
      let ignored = false;
      try {
        execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT });
        ignored = true;
      } catch {
        ignored = false;
      }
      assert.equal(ignored, true, `${p} must stay private`);
    }
  });
});
