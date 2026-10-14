/**
 * A message the bot's own WhatsApp account sends is input only in the bot's own
 * chat. Anywhere else it would run as the person on the other end, which let
 * whoever held the bot's phone or session files act as any user.
 *
 * Run: node --test test/whatsappSelfChat.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isBotSelfChat } = require('../lib/whatsappSelfChat');
const { normalizePhoneNumber } = require('../lib/phone');

const BOT = '2348000000001';
const USER = '2348099999999';
const self = (from, to) => isBotSelfChat({ from, to }, BOT, normalizePhoneNumber);

describe('isBotSelfChat', () => {
  it('accepts Message yourself, addressed to the bot', () => {
    assert.equal(self(`${BOT}@c.us`, `${BOT}@c.us`), true);
  });

  it('accepts a self chat in a single id form at both ends', () => {
    assert.equal(self('112233445566778@lid', '112233445566778@lid'), true);
  });

  it('refuses the bot account typing into a user chat', () => {
    // The attack: fromMe in the user's chat, addressed to the user.
    assert.equal(self(`${BOT}@c.us`, `${USER}@c.us`), false);
    assert.equal(self(`${BOT}@c.us`, '998877665544332@lid'), false);
  });

  it('refuses a chat id that only contains the bot number', () => {
    assert.equal(self(`${BOT}@c.us`, `9${BOT}@c.us`), false);
  });

  it('refuses missing ids', () => {
    assert.equal(self(`${BOT}@c.us`, ''), false);
    assert.equal(self('', `${BOT}@c.us`), false);
    assert.equal(isBotSelfChat(null, BOT, normalizePhoneNumber), false);
  });
});

describe('index.js uses only that rule for bot-sent messages', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const body = source.slice(source.indexOf('async function isAllowedBotChat'));
  const fn = body.slice(0, body.indexOf('\n}\n') > 0 ? body.indexOf('\n}\n') : body.indexOf('\r\n}\r\n'));

  it('decides fromMe with isBotSelfChat', () => {
    assert.match(fn, /isBotSelfChat\(message, botUser, normalizePhoneNumber\)/);
  });

  it('has no sender-is-bot, chat-name or env fallback that widens it', () => {
    assert.doesNotMatch(fn, /fromN === botUser/);
    assert.doesNotMatch(fn, /yourself|\byou\b/);
    assert.doesNotMatch(fn, /BOT_ALLOW_SELF_ON_GETCHAT_FAIL/);
  });
});
