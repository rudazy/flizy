/**
 * Web claim match helpers (no chain / no supabase).
 * Run: node --test test/claimPayoutWeb.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let web;

before(async () => {
  web = await import('../web/lib/claimMatch.ts');
});

describe('claimMatchesAccountKeys', () => {
  it('matches platform by channel + external id', () => {
    const claim = {
      to_channel: 'github',
      to_external_id: '12345',
    };
    assert.equal(
      web.claimMatchesAccountKeys(claim, {
        phones: [],
        identities: [{ channel: 'github', externalId: '12345' }],
      }),
      true
    );
    assert.equal(
      web.claimMatchesAccountKeys(claim, {
        phones: [],
        identities: [{ channel: 'github', externalId: '999' }],
      }),
      false
    );
  });

  it('matches phone claim on digits only', () => {
    const claim = { to_wa_hint: '2348012345678' };
    assert.equal(
      web.claimMatchesAccountKeys(claim, {
        phones: ['2348012345678'],
        identities: [],
      }),
      true
    );
    assert.equal(
      web.claimMatchesAccountKeys(claim, {
        phones: ['2348099999999'],
        identities: [],
      }),
      false
    );
  });

  it('does not let platform identity collect a phone claim', () => {
    const claim = { to_wa_hint: '2348012345678' };
    assert.equal(
      web.claimMatchesAccountKeys(claim, {
        phones: [],
        identities: [{ channel: 'github', externalId: '1' }],
      }),
      false
    );
  });
});

describe('formatClaimClaimedNotice', () => {
  it('pairs claimer with original path', () => {
    const t = web.formatClaimClaimedNotice({
      amountEth: '0.05',
      byLabel: '@alice',
      viaLine: 'GitHub @rudazy',
      explorerUrl: 'https://example/tx/1',
    });
    assert.match(t, /claimed by @alice/);
    assert.match(t, /You sent this to GitHub @rudazy/);
    assert.match(t, /example\/tx\/1/);
  });
});

describe('claimViaLine', () => {
  it('names github holds', () => {
    assert.equal(
      web.claimViaLine({
        to_channel: 'github',
        to_display_handle: 'rudazy',
      }),
      'GitHub @rudazy'
    );
  });
});
