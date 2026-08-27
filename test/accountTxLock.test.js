/**
 * Site money lock: two callers, one lock.
 * Run: node --test test/accountTxLock.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  tryAccountTxLock,
  releaseAccountTxLock,
  LOCK_BUSY,
  LOCK_UNAVAILABLE,
} = require('../lib/accountTxLock');

function makeClient(store) {
  return {
    async rpc(name, args) {
      if (name === 'try_account_tx_lock') {
        const id = args.p_account_id;
        if (store.has(id)) return { data: false, error: null };
        store.set(id, args.p_kind);
        return { data: true, error: null };
      }
      if (name === 'release_account_tx_lock') {
        store.delete(args.p_account_id);
        return { data: null, error: null };
      }
      return { data: null, error: { message: `unknown ${name}` } };
    },
  };
}

describe('tryAccountTxLock', () => {
  it('lets the first caller through and rejects the second', async () => {
    const store = new Map();
    const supabase = makeClient(store);
    const first = await tryAccountTxLock(supabase, 'acc-1', 'pay');
    const second = await tryAccountTxLock(supabase, 'acc-1', 'pay');
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error, LOCK_BUSY);
  });

  it('does not block a different account', async () => {
    const store = new Map();
    const supabase = makeClient(store);
    const a = await tryAccountTxLock(supabase, 'acc-a', 'pay');
    const b = await tryAccountTxLock(supabase, 'acc-b', 'pay');
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });

  it('allows a retry after release', async () => {
    const store = new Map();
    const supabase = makeClient(store);
    assert.equal((await tryAccountTxLock(supabase, 'acc-1', 'pay')).ok, true);
    await releaseAccountTxLock(supabase, 'acc-1');
    assert.equal((await tryAccountTxLock(supabase, 'acc-1', 'pay')).ok, true);
  });

  it('fails closed when the function is missing', async () => {
    const supabase = {
      async rpc() {
        return { data: null, error: { message: 'function does not exist' } };
      },
    };
    const r = await tryAccountTxLock(supabase, 'acc-1', 'pay');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, LOCK_UNAVAILABLE);
  });
});
