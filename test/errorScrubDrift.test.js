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
  // Claim token: randomBytes(16).toString('hex'). No dashes and no 0x, so it
  // slips past both the UUID and the 0x patterns unless it is matched itself.
  'no hold for 9f3a1c2b4d5e60718293a4b5c6d7e8f0',
  `raw key ${'b'.repeat(64)} in a message`,
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

  it('keeps the SDK own ids, in both copies', () => {
    // event_id is a UUID with the dashes removed: 32 hex, the same shape as a
    // claim token. Redacting it corrupts the envelope and the event can be
    // refused at ingest, which switches reporting off without saying so.
    const event = {
      event_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      contexts: { trace: { trace_id: '0123456789abcdef0123456789abcdef' } },
    };
    const fromWeb = web.scrubEvent(event);
    const fromBot = bot.scrubEvent(event);
    assert.deepEqual(fromWeb, fromBot);
    assert.equal(fromBot.event_id, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    assert.equal(fromBot.contexts.trace.trace_id, '0123456789abcdef0123456789abcdef');
  });

  it('does not let a preserved key smuggle something out, in either copy', () => {
    const event = { event_id: 'reach me at ada@example.com', trace_id: '234-801-234-5678' };
    const fromWeb = web.scrubEvent(event);
    const fromBot = bot.scrubEvent(event);
    assert.deepEqual(fromWeb, fromBot);
    assert.equal(fromBot.event_id, 'reach me at [email]');
    assert.equal(fromBot.trace_id, '[phone]');
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

  it('both preserve the same key list', () => {
    for (const key of bot.PRESERVE_KEYS) {
      assert.ok(WEB_SRC.includes(`'${key}'`), `web copy does not preserve ${key}`);
    }
  });
});
