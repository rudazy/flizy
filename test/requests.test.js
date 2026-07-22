const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatRequestsMenu } = require('../lib/paymentRequests');

describe('formatRequestsMenu', () => {
  it('incoming empty', () => {
    assert.match(formatRequestsMenu([], 'incoming'), /No payment requests/);
  });
  it('lists pay menu', () => {
    const t = formatRequestsMenu(
      [{ amount_eth: '0.01', requester_wa: '2348011111111' }],
      'incoming'
    );
    assert.match(t, /1\./);
    assert.match(t, /pay/i);
  });
});
