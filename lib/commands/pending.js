/**
 * What a chat is half-way through: the pending flows, keyed by ctx.key.
 *
 * One map per question the bot can be waiting on -- an unconfirmed plan, a
 * menu pick, an amount after a pasted pay code. Keying on
 * ctx.key is what stops two channels colliding: the same person mid-flow on
 * WhatsApp and on Telegram holds two independent conversations.
 *
 * THIS IS IN MEMORY, AND THAT IS THE KNOWN LIMIT.
 *
 * A restart drops every open question, and a second process would not see the
 * first one's flows at all -- so the bot cannot be scaled horizontally while
 * state lives here. That is survivable on one process against a testnet and it
 * is not survivable on mainnet.
 *
 * Which is the real reason this module exists. Extracting it was the
 * prerequisite for moving handler groups out of router.js, but the more
 * valuable half is that every read and write of pending state now crosses one
 * boundary. Backing it with a table or Redis becomes a change inside this file
 * rather than a change to every handler that asks a question.
 *
 * Anything added here must expire. pruneExpiredPending runs at the top of every
 * turn and PENDING_TTL_MS is the only clock -- the confirm preview quotes the
 * same value, so a plan that says "expires in 5 minutes" and a flow that
 * silently lived longer can never disagree.
 */

const { config } = require('../config');

/**
 * How long any half-finished flow survives. One constant for all of them: the
 * confirm screen prints it, so a flow outliving what the screen promised would
 * be a lie the user could catch.
 */
const PENDING_TTL_MS = config.pendingTtlMs;

/** @type {Map<string, { plan: object, createdAt: number, paymentRequestId?: string|null }>} */
const pendingSends = new Map();

/*
 * pendingWalletAdds is gone. Chat no longer collects an address then a name,
 * because chat no longer adds a payout destination at all. Removing the store
 * as well as the branch means there is nothing for a future flow to resume into
 * by accident.
 */

/** @type {Map<string, { mode: string, claims?: object[], requests?: object[], createdAt: number, awaitConfirmId?: string }>} */
const pendingClaimMenus = new Map();

/** @type {Map<string, { createdAt: number }>} */
const pendingUnlocks = new Map();

/**
 * A numbered question the bot asked, where every answer is a whole command.
 *
 * Used when a command names one side of a trade but not the direction
 * ("trade 100 flz"). Guessing a side is guessing which way somebody's money
 * moves, so the router asks and keeps the two candidate commands here.
 *
 * @type {Map<string, {
 *   kind?: string,
 *   options: Array<{ keyword: string, label: string, command?: string, tokenId?: string }>,
 *   createdAt: number,
 *   ticker?: string,
 *   dest?: object,
 *   token?: object,
 *   nft?: object,
 * }>}
 */
const pendingChoices = new Map();

/** Waiting for an amount after `send giwaforge to ...` picked the token. */
const pendingNamedSends = new Map();

/**
 * A counted NFT send part-way through: `send 2 giwaforge to ...`.
 *
 * ERC-721 moves one token id per call, so "2" is two transactions and two
 * confirms. This is what remembers there is a second one coming while the
 * first is still being approved.
 *
 * `ids` non-null pins an explicit list the sender named. Null means the ids get
 * re-read each round rather than cached: the claim path moves the NFT to escrow
 * as soon as it lands, so a fresh read is what correctly drops the one already
 * sent.
 *
 * @type {Map<string, {
 *   dest: object,
 *   ticker: string,
 *   remaining: number,
 *   total: number,
 *   ids: string[]|null,
 *   sentIds: string[],
 *   createdAt: number,
 * }>}
 */
const pendingMultiNftSends = new Map();

/** @type {Map<string, { amountEth: string, note: string, createdAt: number }>} */
const pendingPayAsks = new Map();

/** @type {Map<string, { address: string, label: string, createdAt: number }>} */
const pendingMerchantSaves = new Map();

/**
 * Paste-first pay: a pay code arrived on its own, and we asked how much.
 *
 * The bank gesture -- type the account number, read the name back, then the
 * amount. Holds the resolved destination so the amount reply does not look it
 * up again, and so the name the payer approved is the name the send uses.
 *
 * @type {Map<string, { code: string, address: string, label: string, createdAt: number }>}
 */
const pendingPayCodes = new Map();

/**
 * Paste-first buy: a contract address arrived on its own, and we asked how much
 * ETH to spend. Holds the symbol so the follow-up can name it without a second
 * chain read.
 *
 * @type {Map<string, { address: string, symbol: string, createdAt: number }>}
 */
const pendingTokenBuys = new Map();

/** code -> { code, createdAt }, while "how much into this pot?" is open. */
const pendingPotPays = new Map();

function pruneExpiredPending() {
  const now = Date.now();
  for (const [key, pending] of pendingSends.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) pendingSends.delete(key);
  }
  for (const [key, menu] of pendingClaimMenus.entries()) {
    if (now - menu.createdAt > PENDING_TTL_MS) pendingClaimMenus.delete(key);
  }
  for (const [key, wait] of pendingUnlocks.entries()) {
    if (now - wait.createdAt > PENDING_TTL_MS) pendingUnlocks.delete(key);
  }
  for (const [key, choice] of pendingChoices.entries()) {
    if (now - choice.createdAt > PENDING_TTL_MS) pendingChoices.delete(key);
  }
  for (const [key, named] of pendingNamedSends.entries()) {
    if (now - named.createdAt > PENDING_TTL_MS) pendingNamedSends.delete(key);
  }
  for (const [key, batch] of pendingMultiNftSends.entries()) {
    if (now - batch.createdAt > PENDING_TTL_MS) pendingMultiNftSends.delete(key);
  }
  for (const [key, ask] of pendingPayAsks.entries()) {
    if (now - ask.createdAt > PENDING_TTL_MS) pendingPayAsks.delete(key);
  }
  for (const [key, save] of pendingMerchantSaves.entries()) {
    if (now - save.createdAt > PENDING_TTL_MS) pendingMerchantSaves.delete(key);
  }
  for (const [key, paste] of pendingPayCodes.entries()) {
    if (now - paste.createdAt > PENDING_TTL_MS) pendingPayCodes.delete(key);
  }
  for (const [key, buy] of pendingTokenBuys.entries()) {
    if (now - buy.createdAt > PENDING_TTL_MS) pendingTokenBuys.delete(key);
  }
  for (const [key, pot] of pendingPotPays.entries()) {
    if (now - pot.createdAt > PENDING_TTL_MS) pendingPotPays.delete(key);
  }
}

/**
 * Throw away every half-finished flow on this channel.
 *
 * Called when the session locks. An in-flight flow does NOT survive a lock: the
 * person who would finish it is the one holding the phone, and a plan started
 * before the lock is not something the owner authorised after it. The
 * hard-lock gate below refuses to advance a flow anyway; this is the layer that
 * means there is nothing left to advance.
 *
 * @param {string} key
 */
function discardPendingFlows(key) {
  pendingSends.delete(key);
  pendingClaimMenus.delete(key);
  pendingUnlocks.delete(key);
  pendingChoices.delete(key);
  pendingNamedSends.delete(key);
  pendingMultiNftSends.delete(key);
  pendingPayAsks.delete(key);
  pendingMerchantSaves.delete(key);
  pendingPayCodes.delete(key);
  pendingTokenBuys.delete(key);
  pendingPotPays.delete(key);
}

/**
 * What the user is mid-way through. Clients use this to decide whether a bare
 * message (no prefix) is input rather than chatter.
 * @param {string} key
 */
function pendingFlowFor(key) {
  return {
    send: pendingSends.has(key),
    claimMenu: pendingClaimMenus.has(key),
    unlock: pendingUnlocks.has(key),
    choice: pendingChoices.has(key),
    namedSend: pendingNamedSends.has(key),
    multiNftSend: pendingMultiNftSends.has(key),
    payAsk: pendingPayAsks.has(key),
    merchantSave: pendingMerchantSaves.has(key),
    payCode: pendingPayCodes.has(key),
    tokenBuy: pendingTokenBuys.has(key),
    potPay: pendingPotPays.has(key),
  };
}
module.exports = {
  PENDING_TTL_MS,
  pruneExpiredPending,
  discardPendingFlows,
  pendingFlowFor,
  pendingSends,
  pendingClaimMenus,
  pendingUnlocks,
  pendingChoices,
  pendingNamedSends,
  pendingMultiNftSends,
  pendingPayAsks,
  pendingMerchantSaves,
  pendingPayCodes,
  pendingTokenBuys,
  pendingPotPays,
};
