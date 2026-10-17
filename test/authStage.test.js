/**
 * Medallion coordinates are numbers. A quoted cx is a string, and
 * cx + 4 then concatenates, which draws a line across the card.
 *
 * Run: node --test test/authStage.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stage = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'components', 'AuthStage.tsx'),
  'utf8'
);

describe('auth stage', () => {
  it('passes medallion coordinates as numbers', () => {
    assert.match(stage, /cx: number; cy: number/);
    assert.doesNotMatch(stage, /<Medallion cx="/);
    assert.doesNotMatch(stage, /<Medallion[^>]*\scy="/);
  });
});
