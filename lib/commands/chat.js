/**
 * How the bot talks to a channel: rendering, addressing, and the one send.
 *
 * Everything a handler needs to produce a message, and nothing about what the
 * message means. No database, no chain reads, no pending flow -- ethers is
 * here to format an address, never to reach a node -- and the only await is the
 * adapter call in reply(), which exists to swallow a channel error so a failed
 * send can never take down the turn that caused it.
 *
 * Pulled out of router.js ahead of the handlers, because it had to go first:
 * reply() and cmd() are called several hundred times between them, so a handler
 * group moved to its own module before this one would have had to import them
 * back from router and make the dependency circular. With this module in place
 * a handler group can move without router being involved at all.
 *
 * cmd() is the reason handlers never hardcode a command: WhatsApp reads
 * "flizy send", Telegram reads "/send", and a handler that writes either one
 * literally is wrong on the other channel.
 */

const { ethers } = require('ethers');
const { config } = require('../config');
const { CHANNELS, normalizeChannel, identityTransferKey } = require('../identity');
const { normalizePhoneNumber } = require('../phone');
const { publicErrorMessage } = require('../sanitize');
const { FUND_REASON } = require('../engine/fundingWall');
const { renderCommand, renderCommands } = require('./render');
const { formatAmount } = require('../amountDisplay');

/** Phones granted admin by configuration rather than by a database flag. */
const ADMIN_PHONES = config.adminPhones;

/**
 * Trim an amount for display.
 *
 * Kept as a name because eleven call sites use it. The rule itself moved to
 * lib/amountDisplay.js, which the site mirrors, so chat and the dashboard
 * finally write the same number.
 */
function formatEth(value) {
  return formatAmount(value);
}

/** Mask address: first 3 and last 3 hex chars after 0x */
function shortAddress(addr) {
  try {
    const a = ethers.getAddress(addr);
    const hex = a.slice(2);
    return `0x${hex.slice(0, 3)}...${hex.slice(-3)}`;
  } catch {
    const s = String(addr || '');
    if (s.length < 10) return s;
    return `${s.slice(0, 5)}...${s.slice(-3)}`;
  }
}

function isTelegram(ctx) {
  return normalizeChannel(ctx.channel) === CHANNELS.TELEGRAM;
}

/**
 * Render a command the way this channel expects it to be typed.
 *
 * The ctx-shaped face of `renderCommand`. Callers without a ctx -- the
 * engine, and any notification that fans out to several channels -- write
 * a `{{cmd:...}}` marker instead, expanded at delivery.
 */
function cmd(ctx, body) {
  return renderCommand(body, ctx.channel);
}

/**
 * The chat half of a funding wall.
 *
 * The engine names the fund page and stops there, because it has no ctx and
 * cannot know this channel types `flizy deposit` rather than `/deposit`. Any
 * refusal built by `fundingWallText` carries FUND_REASON, and that is what
 * earns the second route — `notHeldText` deliberately does not.
 *
 * A decorator rather than a reply wrapper, so an existing reply site composes
 * it without changing shape.
 *
 * @param {object} ctx
 * @param {{ reason?: string }|null|undefined} result Engine result, as returned.
 * @param {string} text The message already built for this result.
 * @returns {string}
 */
function withFundHint(ctx, result, text) {
  if (result?.reason !== FUND_REASON) return text;
  return `${text}\nOr in chat: ${cmd(ctx, 'deposit')}`;
}

function channelName(ctx) {
  return isTelegram(ctx) ? 'Telegram' : 'WhatsApp';
}

/** Key written to transfers.phone / claims.from_wa_sender for this identity. */
function transferKey(ctx) {
  return identityTransferKey(ctx.channel, ctx.externalId);
}

function isAdminUser(user) {
  return Boolean(user?.is_admin) || ADMIN_PHONES.has(normalizePhoneNumber(user?.phone));
}

async function reply(ctx, text, opts) {
  try {
    // The last point before a message leaves, and the first one that knows
    // which channel it is leaving on. Engine copy is written channel-neutral.
    return await ctx.reply(renderCommands(text, ctx.channel), opts);
  } catch (err) {
    console.error(`[reply] ${ctx.key} failed:`, publicErrorMessage(err));
    return null;
  }
}

/** Confirm / cancel prompt with native buttons where the channel has them. */
function confirmButtons() {
  return [
    [
      { label: 'Confirm', value: 'confirm' },
      { label: 'Cancel', value: 'cancel' },
    ],
  ];
}

/**
 * Most NFTs offered as a numbered pick. Bounded by what one chat message and
 * one inline keyboard can carry; numberButtons caps at the same number, and a
 * longer collection is sent by id instead.
 */
const MAX_NFT_PICKS = 20;

/** Numbered picks for WhatsApp/Telegram choice prompts. */
function numberButtons(count) {
  const n = Math.min(Math.max(0, Number(count) || 0), MAX_NFT_PICKS);
  const labels = [];
  for (let i = 1; i <= n; i += 1) labels.push({ label: String(i), value: String(i) });
  const rows = [];
  for (let i = 0; i < labels.length; i += 5) rows.push(labels.slice(i, i + 5));
  rows.push([{ label: 'Cancel', value: 'cancel' }]);
  return rows;
}

module.exports = {
  formatEth,
  shortAddress,
  isTelegram,
  cmd,
  withFundHint,
  channelName,
  transferKey,
  isAdminUser,
  reply,
  confirmButtons,
  MAX_NFT_PICKS,
  numberButtons,
};
