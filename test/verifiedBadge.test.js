/**
 * The Verified badge is shown only where the data says the project is verified,
 * and nothing lets an owner set it.
 *
 * Run: node --test test/verifiedBadge.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('verified badge', () => {
  it('renders behind the verified flag on every surface that shows it', () => {
    assert.match(read('web/components/TaskCard.tsx'), /\{task\.creator\.verified \? <VerifiedBadge/);
    assert.match(read('web/app/tasks/[ref]/page.tsx'), /\{task\.creator\.verified \? <VerifiedBadge/);
    assert.match(read('web/app/project/[handle]/page.tsx'), /\{project\.verified \? <VerifiedBadge/);
    assert.match(read('web/components/AccountProjects.tsx'), /\{project\.verified \? <VerifiedBadge/);
  });

  it('carries a text label for screen readers, not just the icon', () => {
    assert.match(read('web/components/VerifiedBadge.tsx'), /<span className="sr-only">Verified by Flizy<\/span>/);
  });

  it('has no write path in the application', () => {
    const files = [
      'web/lib/tasks.ts',
      'web/app/api/projects/route.ts',
      'web/app/api/projects/handle/route.ts',
    ];
    for (const rel of files) {
      assert.doesNotMatch(read(rel), /verified_at\s*:/, `${rel} writes verified_at`);
    }
  });

  it('ships the column in an idempotent migration that fails loudly when missing', () => {
    const sql = read('supabase/migrations/20261008150000_project_verified.sql');
    assert.match(sql, /add column if not exists verified_at timestamptz/);
    assert.match(sql, /raise exception 'projects\.verified_at is missing'/);
  });
});
