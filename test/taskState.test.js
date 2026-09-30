/**
 * A task's state is a question about the clock, and the boundary is the answer.
 *
 * `status` stores only what a person decided. Whether a live task still takes
 * entries is derived at read time, because this product has no scheduler: no
 * Vercel cron, no job runner, only a per-process outbox poll. A design needing a
 * sweep to close a task would have a step that can stop running, and the first
 * symptom would be a task accepting entries a week after it closed.
 *
 * The instant exactly on the deadline is named here on purpose. Three bugs in one
 * day came from a comparison that read correctly as a sentence and was wrong at
 * its edge, so the rule is written down: `ends_at <= now()` is closed, and the
 * database trigger uses the same comparison so the two cannot disagree.
 *
 * Run: node --test test/taskState.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

/** The module under test is web-side TypeScript, imported directly. */
let tasks;
before(async () => {
  tasks = await import('../web/lib/tasks.ts');
});

const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

describe('deriveTaskState', () => {
  it('is live while the deadline is ahead', () => {
    assert.equal(
      tasks.deriveTaskState({ status: 'live', ends_at: iso(NOW + 1000) }, NOW),
      'live'
    );
  });

  it('is under review the instant the deadline falls', () => {
    // Exactly on the line. `<=` means closed, so this is review and not live.
    assert.equal(tasks.deriveTaskState({ status: 'live', ends_at: iso(NOW) }, NOW), 'review');
  });

  it('is under review one millisecond past it', () => {
    assert.equal(
      tasks.deriveTaskState({ status: 'live', ends_at: iso(NOW - 1) }, NOW),
      'review'
    );
  });

  it('is still live one millisecond before it', () => {
    assert.equal(
      tasks.deriveTaskState({ status: 'live', ends_at: iso(NOW + 1) }, NOW),
      'live'
    );
  });

  it('lets a decision override the clock', () => {
    // A completed or cancelled task stays that way whatever the deadline says,
    // including a completed task whose deadline has not passed yet.
    assert.equal(
      tasks.deriveTaskState({ status: 'completed', ends_at: iso(NOW + 99999) }, NOW),
      'completed'
    );
    assert.equal(
      tasks.deriveTaskState({ status: 'cancelled', ends_at: iso(NOW + 99999) }, NOW),
      'cancelled'
    );
    assert.equal(
      tasks.deriveTaskState({ status: 'completed', ends_at: iso(NOW - 99999) }, NOW),
      'completed'
    );
  });

  it('accepts entries only while live', () => {
    assert.equal(tasks.isAcceptingEntries({ status: 'live', ends_at: iso(NOW + 1) }, NOW), true);
    assert.equal(tasks.isAcceptingEntries({ status: 'live', ends_at: iso(NOW) }, NOW), false);
    assert.equal(
      tasks.isAcceptingEntries({ status: 'completed', ends_at: iso(NOW + 1) }, NOW),
      false
    );
    assert.equal(
      tasks.isAcceptingEntries({ status: 'cancelled', ends_at: iso(NOW + 1) }, NOW),
      false
    );
  });

  it('treats an unparseable deadline as closed, not as open', () => {
    // NaN comparisons are false, which would have read as "still live" and let a
    // corrupt row accept entries for ever. Fail closed.
    assert.equal(tasks.deriveTaskState({ status: 'live', ends_at: 'not a date' }, NOW), 'review');
  });
});

describe('parseXPostUrl', () => {
  it('reads the handle and post id from both hosts', () => {
    for (const host of ['x.com', 'twitter.com', 'www.x.com']) {
      const got = tasks.parseXPostUrl(`https://${host}/alice/status/1234567890`);
      assert.deepEqual(
        got && { handle: got.handle, postId: got.postId },
        { handle: 'alice', postId: '1234567890' },
        host
      );
    }
  });

  it('canonicalises so one post cannot be entered twice', () => {
    const a = tasks.parseXPostUrl('https://twitter.com/Alice/status/1234567890?s=20');
    const b = tasks.parseXPostUrl('https://x.com/Alice/status/1234567890');
    assert.equal(a.canonical, b.canonical);
    assert.equal(a.canonical, 'https://x.com/Alice/status/1234567890');
  });

  it('keeps the trailing-slash and query forms together', () => {
    const plain = tasks.parseXPostUrl('https://x.com/bob/status/555555').canonical;
    assert.equal(tasks.parseXPostUrl('https://x.com/bob/status/555555/').canonical, plain);
    assert.equal(tasks.parseXPostUrl('https://x.com/bob/status/555555#x').canonical, plain);
  });

  it('refuses anything that is not one post', () => {
    const bad = [
      '',
      'not a url',
      'http://x.com/alice/status/1234567890',
      'https://x.com/alice',
      'https://x.com/alice/status/abc',
      'https://x.com/alice/status/',
      'https://example.com/alice/status/1234567890',
      'https://x.com.evil.test/alice/status/1234567890',
      'javascript:alert(1)',
      'https://x.com/alice/status/1234567890 https://x.com/b/status/2',
      null,
      undefined,
    ];
    for (const value of bad) {
      assert.equal(tasks.parseXPostUrl(value), null, JSON.stringify(value));
    }
  });

  it('rejects a handle longer than X allows', () => {
    assert.equal(tasks.parseXPostUrl('https://x.com/aaaaaaaaaaaaaaaaaa/status/123456'), null);
  });
});
