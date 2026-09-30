/**
 * Task clocks. The words on the card and the detail page.
 * Run: node --test test/taskTime.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

describe('task time labels', () => {
  let time;

  before(async () => {
    time = await import('../web/lib/taskTime.ts');
  });

  it('says how long a live card has, coarsely', () => {
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    const inTwoDays = new Date(now + 2 * 24 * 60 * 60 * 1000 + 14 * 60 * 60 * 1000).toISOString();
    assert.equal(time.formatCardEnds(inTwoDays, 'live', now), 'Ends in 2d');
    assert.equal(time.formatCardEnds(inTwoDays, 'review', now), 'Under review');
    assert.equal(time.formatCardEnds(inTwoDays, 'completed', now), 'Completed');
    assert.equal(time.formatCardEnds(inTwoDays, 'cancelled', now), 'Cancelled');
  });

  it('gives the detail page days and hours', () => {
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    const end = new Date(now + (2 * 24 + 14) * 60 * 60 * 1000).toISOString();
    assert.equal(time.formatRemaining(end, now), '2d 14h remaining');
    assert.equal(time.formatRemaining(new Date(now - 1000).toISOString(), now), 'Ended');
  });

  it('formats the instant in the zone it is given', () => {
    const text = time.formatTaskInstant('2026-10-02T15:31:00.000Z', 'Africa/Lagos', 'en-US');
    assert.match(text, /Oct 2, 2026/);
    assert.match(text, /4:31/);
  });
});
