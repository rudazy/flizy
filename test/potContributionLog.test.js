/**
 * A contribution must never be logged as an untagged send.
 *
 * `insertTransfer` retries with a reduced `CORE_KEYS` shape whenever the full
 * insert fails, which exists so an older schema missing the extended columns
 * (asset, direction, counterparty_label) still records the money. That retry is
 * silent by design: it drops columns and carries on.
 *
 * For a pot contribution that behaviour is dangerous rather than helpful. If
 * `pot_id` were dropped, the transfer would succeed, the money would move, and
 * the pot would count nothing -- an organiser told they had been paid less than
 * they actually had, with no error anywhere. Keeping `pot_id` in the retry shape
 * turns that into a loud failure instead.
 *
 * This is its own file because nothing else in the suite covers transferLog, and
 * the invariant is one line in a list that is easy to tidy away.
 *
 * Run: node --test test/potContributionLog.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { mockSupabaseModule } = require('./helpers/fakeSupabase');

/** Records every insert payload, and can be told to fail the first one. */
function recordingClient({ failFirstInsert = false } = {}) {
  const inserts = [];
  let calls = 0;
  return {
    inserts,
    from() {
      return {
        insert(payload) {
          calls += 1;
          inserts.push(payload);
          const fail = failFirstInsert && calls === 1;
          return {
            select() {
              return {
                async single() {
                  return fail
                    ? { data: null, error: { code: '42703', message: 'column "asset" does not exist' } }
                    : { data: { id: 'row-' + calls }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
}

let client;

/**
 * transferLog destructures getSupabase at module load, so replacing the mock
 * after it has been required does nothing. Every test gets a fresh module.
 */
function loadTransferLog(c) {
  client = c;
  mockSupabaseModule(c);
  delete require.cache[require.resolve('../lib/transferLog')];
  return require('../lib/transferLog');
}

beforeEach(() => {
  loadTransferLog(recordingClient());
});

describe('CORE_KEYS', () => {
  it('carries pot_id, so the retry cannot silently untag a contribution', () => {
    // Read from source: the constant is not exported, and exporting it only for
    // a test would be a worse trade than reading the list it actually uses.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../lib/transferLog'), 'utf8');
    const block = src.slice(src.indexOf('const CORE_KEYS'), src.indexOf('];', src.indexOf('const CORE_KEYS')));
    assert.match(block, /'pot_id'/, 'pot_id must stay in the retry shape');
  });
});

describe('logging a contribution', () => {
  it('tags the pot on a clean insert', async () => {
    const { insertTransfer } = require('../lib/transferLog');
    await insertTransfer({
      account_id: 'acc-ada',
      to_address: '0x1111111111111111111111111111111111111111',
      amount_eth: '1.5',
      status: 'pending',
      pot_id: 'pot-1',
      asset: 'ETH',
      direction: 'out',
    });
    assert.equal(client.inserts.length, 1);
    assert.equal(client.inserts[0].pot_id, 'pot-1');
  });

  it('still tags the pot when the full insert fails and it retries', async () => {
    // The regression that matters: money moves either way, so the retry losing
    // pot_id would under-count the pot with nothing to show it happened.
    const { insertTransfer } = loadTransferLog(recordingClient({ failFirstInsert: true }));

    await insertTransfer({
      account_id: 'acc-ada',
      to_address: '0x1111111111111111111111111111111111111111',
      amount_eth: '1.5',
      status: 'pending',
      pot_id: 'pot-1',
      asset: 'ETH',
      direction: 'out',
      counterparty_label: 'pot k7m2q4',
    });

    assert.equal(client.inserts.length, 2, 'expected a retry');
    const retry = client.inserts[1];
    assert.equal(retry.pot_id, 'pot-1', 'retry dropped the pot link');
    // The retry is meant to shed the extended columns; that part must still work.
    assert.equal(retry.asset, undefined);
    assert.equal(retry.counterparty_label, undefined);
  });

  it('leaves an ordinary send untagged', async () => {
    const { insertTransfer } = require('../lib/transferLog');
    await insertTransfer({
      account_id: 'acc-ada',
      to_address: '0x1111111111111111111111111111111111111111',
      amount_eth: '1.5',
      status: 'pending',
    });
    assert.equal(client.inserts[0].pot_id, undefined);
  });
});
