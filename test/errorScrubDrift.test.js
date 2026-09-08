/**
 * The bot and web copies of the scrubber must agree.
 *
 * `web/lib/errorScrub.ts` is a copy of `lib/errorScrub.js` for the same reason
 * `web/lib/amountDisplay.ts` is a copy: a client bundle cannot import the root
 * bot package. Same pattern, same risk, so the same kind of guard.
 *
 * A drifted formatter shows a wrong number. A drifted scrubber leaks whatever
 * the weaker half missed, on the surface nobody is watching -- so this compares
 * behaviour on the exact strings that matter, not just the source text.
 *
 * Run: node --test test/errorScrubDrift.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const bot = require('../lib/errorScrub');

const WEB_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'lib', 'errorScrub.ts'),
  'utf8'
);

/** The strings the two halves must treat identically. */
const CASES = [
  'no account for 2348012345678',
  'call 234-801-234-5678 now',
  'call 234 801 234 5678 now',
  'account 52488385-1234-4000-8000-abcdefabcdef missing',
  'no user with ada@example.com',
  'send to 0x1111111111111111111111111111111111111111 failed',
  `key 0x${'a'.repeat(64)} leaked`,
  'insufficient balance: 0.025 ETH on chain 91342',
  'nothing identifying here at all',
];

/**
 * Run the web copy without a TypeScript step: strip the type syntax this file
 * uses and evaluate it. Narrow on purpose -- if the web copy grows syntax this
 * cannot handle, the test fails loudly rather than quietly skipping.
 */
function loadWebScrub() {
  const js = WEB_SRC.replace(/^import .*$/gm, '')
    .replace(/export function/g, 'function')
    .replace(/: RegExp\[\]/g, '')
    .replace(/: Array<\[RegExp, string\]>/g, '')
    .replace(/: Record<string, unknown>/g, '')
    .replace(/: unknown\b/g, '')
    .replace(/: string\b/g, '')
    .replace(/: number\b/g, '')
    .replace(/ as Record<string, unknown>/g, '')
    .replace(/\(value as Record<string, unknown>\)/g, 'value');

  // eslint-disable-next-line no-new-func
  const factory = new Function(`${js}; return { scrubText, scrubValue, scrubEvent };`);
  return factory();
}

describe('the two scrubbers agree', () => {
  const web = loadWebScrub();

  for (const input of CASES) {
    it(`treats "${input.slice(0, 40)}" the same`, () => {
      assert.equal(web.scrubText(input), bot.scrubText(input), 'the copies disagree');
    });
  }

  it('drops the same fields by name', () => {
    const sample = {
      accountId: '52488385-1234-4000-8000-abcdefabcdef',
      agent_wallet_address: '0x1111111111111111111111111111111111111111',
      amount: '0.02',
    };
    assert.deepEqual(web.scrubValue(sample), bot.scrubValue(sample));
  });

  it('produces the same event', () => {
    const event = {
      message: 'pay failed for 2348012345678',
      user: { id: 'x', email: 'a@b.com' },
      extra: { amount: '0.02' },
    };
    assert.deepEqual(web.scrubEvent(event), bot.scrubEvent(event));
  });
});

describe('neither copy can quietly lose a rule', () => {
  it('both carry every PII shape', () => {
    // Comparing the source keeps a rule from being deleted in one half while
    // the behavioural cases above happen not to cover it.
    for (const marker of ['[email]', '[id]', '[address]', '[phone]', '[redacted]']) {
      assert.ok(WEB_SRC.includes(marker), `web copy lost ${marker}`);
    }
  });

  it('both drop the same key list', () => {
    for (const key of bot.DROP_KEYS) {
      assert.ok(WEB_SRC.includes(`'${key}'`), `web copy does not drop ${key}`);
    }
  });
});
