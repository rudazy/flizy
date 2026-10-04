/**
 * PostgreSQL regular expressions cap a repetition count at 255. A pattern like
 * {1,500} is accepted when the constraint is created and only fails when a row
 * is checked, with "invalid repetition count(s)", so it passes every migration
 * and breaks the first real insert. This finds any such count in a migration.
 *
 * Run: node --test test/migrationRegex.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');

describe('migration regex patterns', () => {
  it('no repetition count above 255', () => {
    const offenders = [];
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
      sql.split(/\r?\n/).forEach((line, i) => {
        if (line.trim().startsWith('--')) return;
        for (const m of line.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
          const counts = [Number(m[1]), m[2] ? Number(m[2]) : 0];
          if (counts.some((n) => n > 255)) offenders.push(`${file}:${i + 1} ${m[0]}`);
        }
      });
    }
    assert.deepEqual(offenders, []);
  });
});
