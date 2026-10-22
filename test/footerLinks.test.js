/**
 * The footer's bot links: Telegram's public username when set, and the
 * WhatsApp number only where the deploy allows it in public HTML.
 *
 * Run: node --test test/footerLinks.test.js
 */

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const KEYS = ['TELEGRAM_BOT_USERNAME', 'BOT_WHATSAPP_NUMBER', 'NEXT_PUBLIC_BOT_WHATSAPP_NUMBER', 'NEXT_PUBLIC_SHOW_BOT_NUMBER'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

let bot;
before(async () => {
  bot = await import('../web/lib/botPublic.ts');
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function set(env) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

describe('footer bot links', () => {
  it('links the Telegram bot by its username, with or without the @', () => {
    set({ TELEGRAM_BOT_USERNAME: '@FlizyBot' });
    assert.equal(bot.footerBotLinks().telegramUrl, 'https://t.me/FlizyBot');
  });

  it('gives no Telegram link for an unset or malformed username', () => {
    set({});
    assert.equal(bot.footerBotLinks().telegramUrl, null);
    set({ TELEGRAM_BOT_USERNAME: 'bad name/../x' });
    assert.equal(bot.footerBotLinks().telegramUrl, null);
  });

  it('keeps the WhatsApp number out of public HTML unless the deploy allows it', () => {
    set({ BOT_WHATSAPP_NUMBER: '+2348000000000' });
    assert.equal(bot.footerBotLinks().whatsappUrl, null);
    set({ BOT_WHATSAPP_NUMBER: '+2348000000000', NEXT_PUBLIC_SHOW_BOT_NUMBER: 'true' });
    assert.equal(bot.footerBotLinks().whatsappUrl, 'https://wa.me/2348000000000');
  });

  it('the layout passes the links on the server, and the footer falls back to the Guide', () => {
    const web = (...p) => fs.readFileSync(path.join(__dirname, '..', 'web', ...p), 'utf8');
    assert.match(web('app', 'layout.tsx'), /<AppChrome signedIn=\{signedIn\} \{\.\.\.footerBotLinks\(\)\}>/);
    const footer = web('components', 'SiteFooter.tsx');
    assert.match(footer, /href=\{telegramUrl \?\? '\/how-it-works'\}/);
    assert.match(footer, /href=\{whatsappUrl \?\? '\/how-it-works'\}/);
  });
});
