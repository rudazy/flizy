/**
 * Public claim page kind flags (email vs phone vs platform).
 * Run: node --test test/publicClaimAccess.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let web;

before(async () => {
  web = await import('../web/lib/claimRecipient.ts');
});

describe('publicClaimAccess', () => {
  it('marks platform holds as claimable on the site', () => {
    const a = web.publicClaimAccess({
      to_channel: 'github',
      to_external_id: '1',
      to_display_handle: 'rudazy',
    });
    assert.equal(a.recipient_kind, 'platform');
    assert.equal(a.can_claim_on_web, true);
  });

  it('marks email holds as email, not phone, and claimable on the site', () => {
    const a = web.publicClaimAccess({
      to_email: 'you@domain.com',
      to_wa_hint: null,
      to_channel: null,
    });
    assert.equal(a.recipient_kind, 'email');
    assert.equal(a.can_claim_on_web, true);
  });

  it('keeps phone holds chat-only', () => {
    const a = web.publicClaimAccess({ to_wa_hint: '2348012345678' });
    assert.equal(a.recipient_kind, 'phone');
    assert.equal(a.can_claim_on_web, false);
  });
});
