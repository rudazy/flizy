/**
 * Which holdings rows the wallet lists.
 *
 * The rule Ludarep asked for is "only show it if I have it", and the trap in
 * implementing it is the unreadable row: /api/holdings reports a token or
 * collection it could not reach as balance null with an `error`, and that must
 * NOT be filtered out. Hiding it would render "we could not reach the contract"
 * as "you own none", which is indistinguishable from the truth and would tell
 * someone their NFT had vanished. Most of these cases guard that, not the zero.
 *
 * Run: node --test test/holdingsDisplay.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { isHeldBalance } = require('../lib/holdings');

let isHeld;

before(async () => {
  ({ isHeld } = await import('../web/lib/dashboardTypes.ts'));
});

describe('isHeld — hides what is not held', () => {
  it('hides a plain zero', () => {
    assert.equal(isHeld('0'), false);
  });

  it('hides a formatted zero, which is what the API actually sends', () => {
    // ethers.formatUnits(0n, 18) and the NFT count both land here.
    for (const zero of ['0.0', '0.00000', '0.000000000000000000']) {
      assert.equal(isHeld(zero), false, `${zero} should be hidden`);
    }
  });

  it('hides a negative, however it got there', () => {
    assert.equal(isHeld('-1'), false);
  });
});

describe('isHeld — shows what is held', () => {
  it('shows a whole balance', () => {
    assert.equal(isHeld('192.4431'), true);
  });

  it('shows an NFT count of 1', () => {
    assert.equal(isHeld('1'), true);
  });

  it('shows one wei, so dust is never silently dropped', () => {
    assert.equal(isHeld('0.000000000000000001'), true);
  });
});

describe('isHeld — never reports "none" when the balance is unknown', () => {
  it('keeps a row that could not be read', () => {
    // { symbol: 'FLZ', balance: null, error: 'Could not read' }
    assert.equal(isHeld(null), true);
  });

  it('keeps a row with no balance field at all', () => {
    assert.equal(isHeld(undefined), true);
  });

  it('keeps a row whose balance does not parse', () => {
    assert.equal(isHeld('unavailable'), true);
  });

  it('keeps a row whose balance is empty rather than reading it as zero', () => {
    assert.equal(isHeld(''), true);
    assert.equal(isHeld('   '), true);
  });
});

/**
 * The drift guard, in the spirit of test/webAgentWallet.test.js. The same rule
 * is implemented twice — isHeld for the site, isHeldBalance for chat — because
 * one is TS/ESM and the other CommonJS. If they ever disagree, the wallet and
 * `flizy balance` start telling the same person different things about the same
 * wallet, which is exactly the class of bug this whole change was fixing.
 */
describe('chat and web agree on what counts as held', () => {
  it('matches on every vector', () => {
    const vectors = [
      '0',
      '0.0',
      '0.00000',
      '0.000000000000000000',
      '-1',
      '1',
      '192.4431',
      '0.000000000000000001',
      '',
      '   ',
      'unavailable',
      null,
      undefined,
    ];
    for (const v of vectors) {
      assert.equal(
        isHeldBalance(v),
        isHeld(v),
        `chat and web disagreed on ${JSON.stringify(v)}`
      );
    }
  });
});

describe('the screenshot case', () => {
  it('empties both lists when the wallet holds only zeroes', () => {
    const tokens = [{ symbol: 'FLZ', address: '0xflz', balance: '0.0' }];
    const nfts = [{ ticker: 'giwaforge', address: '0xnft', balance: '0', ids: [] }];
    assert.deepEqual(tokens.filter((t) => isHeld(t.balance)), []);
    assert.deepEqual(nfts.filter((n) => isHeld(n.balance)), []);
  });

  it('keeps the held rows and drops the rest in one mixed list', () => {
    const tokens = [
      { symbol: 'FLZ', balance: '0.0' },
      { symbol: 'USDC', balance: '25.5' },
      { symbol: 'WETH', balance: null, error: 'Could not read' },
    ];
    assert.deepEqual(
      tokens.filter((t) => isHeld(t.balance)).map((t) => t.symbol),
      ['USDC', 'WETH']
    );
  });
});
