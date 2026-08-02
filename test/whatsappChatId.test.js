/**
 * WhatsApp outbound chat id candidates for notify.
 * Run: node --test test/whatsappChatId.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { whatsappOutboundChatIds } = require('../lib/whatsappChatId');

describe('whatsappOutboundChatIds', () => {
  it('prefers @lid before @c.us for phone-shaped ids (LID collision)', () => {
    // 15-digit LID looks like E.164; @c.us alone never delivered for these users
    const ids = whatsappOutboundChatIds('216123456789017');
    assert.deepEqual(ids, ['216123456789017@lid', '216123456789017@c.us']);
  });

  it('uses both forms for a normal phone', () => {
    const ids = whatsappOutboundChatIds('2348012345678');
    assert.equal(ids[0], '2348012345678@lid');
    assert.equal(ids[1], '2348012345678@c.us');
  });

  it('strips an existing server suffix', () => {
    assert.deepEqual(whatsappOutboundChatIds('2348012345678@c.us')[1], '2348012345678@c.us');
  });

  it('returns empty for blank', () => {
    assert.deepEqual(whatsappOutboundChatIds(''), []);
  });
});
