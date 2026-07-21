/**
 * Phase 1 helper: create an account (if needed) and print a wa.me link code.
 * CMD: node scripts\create-link.js [displayName]
 *
 * Does not print secrets. Bot number comes from BOT_WHATSAPP_NUMBER.
 */

require('dotenv').config();
const { createAccountStub, createLinkCode } = require('../lib/identity');
const { config } = require('../lib/config');

async function main() {
  const displayName = process.argv[2] || null;
  const account = await createAccountStub(displayName);
  const link = await createLinkCode(account.id);

  console.log('Account created (stub wallet, custody later)');
  console.log('account_id:', account.id);
  console.log('code:', link.code);
  console.log('expires_at:', link.expiresAt);
  console.log('wa_deep_link:', link.waDeepLink);
  console.log('');
  console.log('Send this from your WhatsApp to the bot:');
  console.log(`  flizy link ${link.code}`);
  if (!config.botWhatsAppNumber) {
    console.log('(Set BOT_WHATSAPP_NUMBER in .env for a full wa.me URL.)');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
