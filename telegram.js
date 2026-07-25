/**
 * Flizy Telegram entrypoint.
 *
 * Runs as its own process (systemd: flizy-telegram.service) against the same
 * database, engine and wallets as the WhatsApp client. Long polling, so no
 * public webhook URL is required.
 *
 * Start: node telegram.js
 */

require('dotenv').config();

// Fails fast on shared env (Supabase, RPC, keys) before anything else starts
const { chain, opsWallet, escrowWallet, addressUrl } = require('./lib/runtime');
const { config } = require('./lib/config');
const { TelegramBot } = require('./lib/telegram/bot');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Missing TELEGRAM_BOT_TOKEN.');
  console.error('Add it to .env (never commit it), then start again.');
  process.exit(1);
}

const bot = new TelegramBot({ token, pollTimeoutSec: config.telegramPollTimeoutSec });

async function main() {
  console.log(`Chain:                  ${chain.name} (${chain.chainId})`);
  console.log(`Ops wallet (gas/infra): ${opsWallet.address}`);
  console.log(`Claim escrow:           ${escrowWallet.address}`);
  console.log(`Explorer ops:           ${addressUrl(opsWallet.address)}`);
  await bot.start();
}

function shutdown(signal) {
  console.log(`\n${signal} received, stopping Telegram client.`);
  bot.stop();
  // Let the in-flight long poll settle before exiting
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('Failed to start Telegram client:', err.message);
  process.exit(1);
});
