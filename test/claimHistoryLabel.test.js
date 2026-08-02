/**
 * Claim history rails: GitHub pay / Phone pay / X pay
 * Run: node --test test/claimHistoryLabel.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  claimHistoryPeer,
  formatClaimHistoryLabel,
  claimHistoryCounterparty,
} = require('../lib/claimHistoryLabel');

describe('claimHistoryPeer', () => {
  it('labels GitHub holds as GitHub pay + @handle', () => {
    const p = claimHistoryPeer({
      to_channel: 'github',
      to_external_id: '583231',
      to_display_handle: 'rudazy',
      to_wa_hint: null,
    });
    assert.equal(p.rail, 'GitHub pay');
    assert.equal(p.peer, '@rudazy');
  });

  it('labels phone holds as Phone pay + digits', () => {
    const p = claimHistoryPeer({
      to_wa_hint: '2348012345678',
      to_channel: null,
      to_external_id: null,
    });
    assert.equal(p.rail, 'Phone pay');
    assert.equal(p.peer, '+2348012345678');
  });

  it('labels X holds as X pay', () => {
    const p = claimHistoryPeer({
      to_channel: 'x',
      to_external_id: '123',
      to_display_handle: 'jack',
    });
    assert.equal(p.rail, 'X pay');
    assert.equal(p.peer, '@jack');
  });
});

describe('formatClaimHistoryLabel', () => {
  const gh = {
    amount_eth: '0.0005',
    status: 'claimed',
    to_channel: 'github',
    to_display_handle: 'rudazy',
    to_external_id: '1',
    to_wa_hint: null,
  };

  it('sender claimed line includes GitHub pay and handle', () => {
    const t = formatClaimHistoryLabel(gh, { role: 'sender', status: 'claimed' });
    assert.match(t, /GitHub pay/);
    assert.match(t, /@rudazy/);
    assert.match(t, /claimed/);
    assert.match(t, /0\.0005 ETH/);
  });

  it('receiver claimed line is Received · GitHub pay', () => {
    const t = formatClaimHistoryLabel(gh, { role: 'receiver', status: 'claimed' });
    assert.match(t, /^Received · GitHub pay/);
    assert.match(t, /@rudazy/);
  });

  it('phone receiver line uses Phone pay', () => {
    const t = formatClaimHistoryLabel(
      { amount_eth: '0.01', status: 'claimed', to_wa_hint: '2348012345678' },
      { role: 'receiver', status: 'claimed' }
    );
    assert.match(t, /Phone pay/);
    assert.match(t, /\+2348012345678/);
  });
});

describe('claimHistoryCounterparty', () => {
  it('combines rail and peer', () => {
    assert.equal(
      claimHistoryCounterparty({
        to_channel: 'github',
        to_display_handle: 'rudazy',
        to_external_id: '1',
      }),
      'GitHub pay @rudazy'
    );
  });
});
