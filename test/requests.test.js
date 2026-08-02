const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatRequestsMenu, formatRequestPaidNotice } = require('../lib/paymentRequests');

describe('formatRequestsMenu', () => {
  it('incoming empty', () => {
    const t = formatRequestsMenu([], 'incoming');
    assert.match(t, /No payment requests/);
    assert.match(t, /\/phone/);
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

describe('formatRequestPaidNotice', () => {
  it('names the payer and amount for the requester', () => {
    const t = formatRequestPaidNotice({
      amountEth: '0.001',
      fromLabel: '+2349068893161',
      explorerUrl: 'https://explorer.test/tx/0xabc',
    });
    assert.match(t, /Payment received/i);
    assert.match(t, /0\.001 ETH from \+2349068893161/);
    assert.match(t, /agent wallet/i);
    assert.match(t, /explorer\.test/);
  });

  it('still works without explorer or label', () => {
    const t = formatRequestPaidNotice({ amountEth: '0.01' });
    assert.match(t, /0\.01 ETH from someone/);
  });
});
