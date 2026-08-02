const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatRequestsMenu, formatRequestPaidNotice } = require('../lib/paymentRequests');
const { formatClaimClaimedNotice, claimViaLine } = require('../lib/claims');

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

describe('formatClaimClaimedNotice', () => {
  it('pairs claimer with the original GitHub path so the sender is not confused', () => {
    const t = formatClaimClaimedNotice({
      amountEth: '0.0005',
      byLabel: '@youser',
      viaLine: 'GitHub @rudazy',
      explorerUrl: 'https://explorer.test/tx/0xdef',
    });
    assert.match(t, /Claim delivered/i);
    assert.match(t, /0\.0005 ETH claimed by @youser/);
    assert.match(t, /You sent this to GitHub @rudazy/);
    assert.match(t, /explorer\.test/);
  });
});

describe('claimViaLine', () => {
  it('names a GitHub hold as GitHub @handle', () => {
    const line = claimViaLine({
      to_channel: 'github',
      to_external_id: '583231',
      to_display_handle: 'rudazy',
      to_wa_hint: null,
    });
    assert.equal(line, 'GitHub @rudazy');
  });

  it('names a phone hold as phone +digits', () => {
    const line = claimViaLine({
      to_wa_hint: '2348012345678',
      to_channel: null,
      to_external_id: null,
    });
    assert.equal(line, 'phone +2348012345678');
  });
});
