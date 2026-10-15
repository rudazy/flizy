/**
 * The link-code attempt counter fails open, and says so.
 *
 * Link codes tolerate a missing or failing attempt counter because 50 bits of
 * entropy stand behind it, so an unreadable counter must not take linking
 * down. What the counter does report is whether it degraded (`degraded` on
 * the lock state, `recorded` on a failure), so a caller can tell.
 *
 * Run: node --test test/linkAttemptsFailOpen.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeSupabase, mockSupabaseModule } = require('./helpers/fakeSupabase');

let fake = createFakeSupabase();

/** Which link_code_attempts operations fail: 'none', 'read' or 'write'. */
let counterFails = 'none';

/** A query builder whose every chain step returns itself and whose result is an error. */
function failingBuilder() {
  const result = { data: null, error: { message: 'connection reset', code: 'XX000' } };
  const builder = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return (resolve) => resolve(result);
        if (prop === 'maybeSingle' || prop === 'single') return async () => result;
        return () => builder;
      },
    }
  );
  return builder;
}

function from(table) {
  if (table === 'link_code_attempts' && counterFails === 'read') return failingBuilder();
  if (table === 'link_code_attempts' && counterFails === 'write') {
    const real = fake.client.from(table);
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'upsert' || prop === 'update' || prop === 'insert') return () => failingBuilder();
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  return fake.client.from(table);
}

mockSupabaseModule({ from, rpc: (name, args) => fake.client.rpc(name, args) });

const { linkLockState, recordFailedLinkAttempt } = require('../lib/linkAttempts');

const TG_ID = '553311888';

function seed() {
  counterFails = 'none';
  fake = createFakeSupabase({ link_code_attempts: [] });
}

describe('link codes keep failing open', () => {
  beforeEach(seed);

  it('reports unlocked but degraded when the counter cannot be read', async () => {
    counterFails = 'read';
    const lock = await linkLockState('telegram', TG_ID);
    assert.equal(lock.locked, false);
    assert.equal(lock.degraded, true);
  });

  it('reports an unrecorded failure without a lock', async () => {
    counterFails = 'write';
    const counted = await recordFailedLinkAttempt('telegram', TG_ID);
    assert.equal(counted.recorded, false);
    assert.equal(counted.lockedForMs, 0);
  });

  it('reports a recorded failure when the counter works', async () => {
    const counted = await recordFailedLinkAttempt('telegram', TG_ID);
    assert.equal(counted.recorded, true);
    assert.equal(counted.attempts, 1);
  });
});
