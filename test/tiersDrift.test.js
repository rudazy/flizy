/**
 * Chat and site decide Tier 0 versus Tier 1 the same way.
 *
 * web/ cannot import root lib/ on Vercel, so web/lib/tiers.ts mirrors
 * lib/tiers.js. "Known" is one SQL function both call; the rule and the
 * quick-send amount are the mirrored part, and this pins them.
 *
 * Run: node --test test/tiersDrift.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const chat = require('../lib/tiers');
let site;

before(async () => {
  site = await import('../web/lib/tiers.ts');
});

const E15 = 10n ** 15n;

describe('tiers, chat and site', () => {
  it('read amounts as wei identically', () => {
    for (const v of [null, undefined, '', 0, '0', 0.005, '0.005', 1e-7, '1e-7', -1, 'nope', ' 0.004 ', '0.0050000']) {
      assert.equal(chat.ethToWei(v), site.ethToWei(v), String(v));
    }
  });

  it('resolve the quick-send amount identically', () => {
    const accounts = [
      null,
      {},
      { quick_send_eth: null },
      { quick_send_eth: '' },
      { quick_send_eth: 0 },
      { quick_send_eth: '0.001' },
      { quick_send_eth: '0.005000000000000000' },
      { quick_send_eth: 1 },
      { quick_send_eth: -1 },
      { quick_send_eth: 'nope' },
    ];
    for (const account of accounts) {
      for (const def of [0, 0.005, 0.01]) {
        assert.equal(chat.quickSendWei(account, def), site.quickSendWei(account, def), JSON.stringify({ account, def }));
      }
    }
  });

  it('evaluate every combination identically', () => {
    for (const action of ['send', 'swap', 'other']) {
      for (const native of [true, false]) {
        for (const amountWei of [0n, 1n, 4n * E15, 5n * E15, 5n * E15 + 1n]) {
          for (const quickSendWei of [0n, 5n * E15]) {
            for (const known of [true, false, undefined]) {
              for (const verified of [true, false, undefined]) {
                const input = { action, native, amountWei, quickSendWei, known, verified };
                assert.deepEqual(chat.evaluateTier(input), site.evaluateTier(input), JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? String(v) : v)));
              }
            }
          }
        }
      }
    }
  });
});
