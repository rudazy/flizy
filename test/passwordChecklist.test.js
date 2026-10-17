/**
 * The wide signup card draws one mark per password rule.
 * Those marks have to agree with validatePassword, or a password the
 * server will reject can show every mark filled.
 *
 * Run: node --test test/passwordChecklist.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

describe('password checklist', () => {
  let policy;

  before(async () => {
    policy = await import('../web/lib/passwordPolicy.ts');
  });

  it('is all true only when validatePassword accepts', () => {
    const samples = [
      '',
      'short1!',
      'longenough',
      'Longenough1',
      '!!!!!!!!',
      'Longenough!',
      'Longenough1!',
      `Aa1!${'b'.repeat(124)}`,
      `Aa1!${'b'.repeat(125)}`,
    ];
    for (const sample of samples) {
      const marks = policy.passwordChecklist(sample);
      assert.equal(marks.length, 3);
      const allOk = marks.every((mark) => mark.ok);
      assert.equal(allOk, policy.validatePassword(sample).ok, `length ${sample.length}`);
    }
  });

  it('rejects a password over 128 characters on the length mark', () => {
    const marks = policy.passwordChecklist(`Aa1!${'b'.repeat(125)}`);
    assert.equal(marks[0].ok, false);
    assert.equal(marks[1].ok, true);
    assert.equal(marks[2].ok, true);
  });

  it('the signup card uses that list and does not keep a second copy of the rules', () => {
    const form = fs.readFileSync(path.join(root, 'web/app/signup/SignupForm.tsx'), 'utf8');
    assert.match(form, /passwordChecklist\(password\)/);
    assert.doesNotMatch(form, /\[!@#\$%\^&/);
  });
});
