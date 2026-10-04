/**
 * Words and times on the Mint screens.
 *
 * Run: node --test test/mintFormat.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let m;
before(async () => {
  m = await import('../web/lib/mintFormat.ts');
});

describe('statusLabel', () => {
  it('names every status', () => {
    assert.equal(m.statusLabel('public', false), 'Mint live');
    assert.equal(m.statusLabel('allowlist', false), 'Mint live');
    assert.equal(m.statusLabel('live', true), 'Mint live');
    assert.equal(m.statusLabel('upcoming', false), 'Upcoming');
    assert.equal(m.statusLabel('sold_out', false), 'Sold out');
    assert.equal(m.statusLabel('ended', false), 'Mint ended');
    assert.equal(m.statusLabel('paused', false), 'Paused');
    assert.equal(m.statusLabel('unconfigured', false), 'Not set up');
    assert.ok(m.isLiveStatus('allowlist') && !m.isLiveStatus('upcoming'));
  });
});

describe('countdown', () => {
  it('days, hours, minutes, seconds, never negative', () => {
    assert.equal(m.countdown(1000 + 2 * 86400 + 3 * 3600, 1000), '2d 03h');
    assert.equal(m.countdown(1000 + 4 * 3600 + 21 * 60, 1000), '04h 21m');
    assert.equal(m.countdown(1000 + 125, 1000), '2m 05s');
    assert.equal(m.countdown(1000 + 45, 1000), '45s');
    assert.equal(m.countdown(900, 1000), '0s');
  });
});

describe('UTC times', () => {
  it('round-trips the datetime-local field as UTC', () => {
    const sec = Date.UTC(2026, 4, 12, 18, 0) / 1000;
    assert.equal(m.secToUtcInput(sec), '2026-05-12T18:00');
    assert.equal(m.utcInputToSec('2026-05-12T18:00'), sec);
    assert.equal(m.utcLabel(sec), 'May 12, 18:00 UTC');
  });

  it('empty or junk is 0', () => {
    assert.equal(m.utcInputToSec(''), 0);
    assert.equal(m.utcInputToSec('tomorrow'), 0);
    assert.equal(m.secToUtcInput(0), '');
  });
});

describe('scheduleSteps', () => {
  const c = { allowlistStart: 100, allowlistEnd: 200, publicStart: 200, mintEnd: 500 };
  it('marks each step done, live or next', () => {
    assert.deepEqual(m.scheduleSteps(c, 50).map((s) => s.state), ['next', 'next', 'next']);
    assert.deepEqual(m.scheduleSteps(c, 150).map((s) => s.state), ['live', 'next', 'next']);
    assert.deepEqual(m.scheduleSteps(c, 300).map((s) => s.state), ['done', 'live', 'next']);
    assert.deepEqual(m.scheduleSteps(c, 600).map((s) => s.state), ['done', 'done', 'done']);
  });

  it('a public-only drop with no end ends at sellout', () => {
    const steps = m.scheduleSteps({ allowlistStart: 0, allowlistEnd: 0, publicStart: 200, mintEnd: 0 }, 300);
    assert.deepEqual(steps.map((s) => s.key), ['public', 'end']);
    assert.equal(steps[1].when, 'At sellout');
  });
});
