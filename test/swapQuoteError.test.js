/**
 * Quote failures become fixed sentences. A provider message is not one of them.
 *
 * Run: node --test test/swapQuoteError.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let quotes;

describe('swap quote errors', () => {
  it('loads', async () => {
    quotes = await import('../web/lib/swapQuoteError.ts');
  });

  it('names the two cases a person can act on', () => {
    const same = quotes.asSwapQuoteError(new Error('Cannot swap a token for itself'));
    assert.match(same.message, /ETH on this chain/);
    const unread = quotes.asSwapQuoteError(new Error('Token decimals could not be read'));
    assert.match(unread.message, /could not be read/);
    const pool = quotes.asSwapQuoteError(Object.assign(new Error('execution reverted at https://rpc.example'), { code: 'CALL_EXCEPTION' }));
    assert.equal(pool.message, 'No ETH pool for that token.');
    assert.doesNotMatch(pool.message, /https/);
  });

  it('does not forward an unknown provider message', () => {
    assert.equal(quotes.asSwapQuoteError(new Error('https://rpc.example/secret')), null);
  });
});
