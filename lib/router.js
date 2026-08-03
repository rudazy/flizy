/**
 * Flizy command router — channel agnostic.
 *
 * Clients (WhatsApp, Telegram) turn a chat message into a ctx and hand the raw
 * text here. Everything below this line is the same product on every channel:
 * the same Intent, the same Policy, the same Plan, the same receipts.
 *
 * A client NEVER decides money rules. It only supplies:
 *   ctx.channel      'whatsapp' | 'telegram'
 *   ctx.externalId   the chat identity on that channel
 *   ctx.key          `${channel}:${externalId}` (pending flows, logs)
 *   ctx.reply        (text, opts) => Promise   opts.buttons is optional
 *   ctx.resolveVerifiedPhone  optional, returns a channel-verified phone
 *   ctx.raw          the underlying message object (never used for logic)
 */

const { ethers } = require('ethers');

const { config } = require('./config');
const { chain, supabase, provider, opsWallet, escrowWallet, txUrl, addressUrl, getOpsBalanceEth } =
  require('./runtime');
const { publicErrorMessage, displaySafeLabel } = require('./sanitize');
const { formatUsernameLabel } = require('./username');
const {
  CHANNELS,
  normalizeChannel,
  identityTransferKey,
  getAccountByIdentity,
  getOrCreateAccountForIdentity,
  consumeLinkCode,
  setIdentityPhone,
  findAccountIdByPhone,
  listIdentitiesForAccount,
} = require('./identity');
const {
  normalizePhoneNumber,
  isPlausiblePhone,
  claimMatchKeys,
  claimMatchKeysForAccount,
  maskPhone,
} = require('./phone');
const { maskLinkCode } = require('./linkCode');
const { stripFlizyPrefix, parseUnlockCommand, parseLockCommand } = require('./prefix');
const {
  isSessionUnlocked,
  isSessionHardLocked,
  unlockWithPin,
  touchSession,
  lockSession,
  getSession,
} = require('./session');
const { addTrusted } = require('./trusted');
const {
  normalizeWaHint,
  listOutgoingPending,
  listIncomingPending,
  formatClaimsMenu,
  formatClaimClaimedNotice,
  claimViaLine,
  claimRecipientLabel,
} = require('./claims');
const { platformRecipient } = require('./claimRecipient');
const { resolveGitHubUser, normalizeGitHubLogin } = require('./githubLookup');
const { formatClaimHistoryLabel } = require('./claimHistoryLabel');
const { ensureAgentWallet } = require('./agentWallet');
const { formatEscrowStatus } = require('./escrowWallet');
const { getWalletHoldings, formatHoldingsMessage } = require('./holdings');
const {
  createSendIntent,
  createSwapIntent,
  evaluateSendPolicy,
  evaluateClaimHoldPolicy,
  evaluateSwapPolicy,
  buildSendPlan,
  formatPlanPreview,
  assertPlanFunded,
  buildClaimPlan,
  formatClaimPlanPreview,
  buildSwapPlan,
  formatSwapPlanPreview,
  executeNativeSend,
  executeClaimHold,
  executeClaimRefund,
  executeClaimPayout,
  executeSwapPlan,
  formatSendReceipt,
  formatSwapReceipt,
} = require('./engine');
const {
  createPaymentRequest,
  listOutgoingRequests,
  listIncomingRequests,
  beginRequestProcessing,
  releaseRequestProcessing,
  cancelPaymentRequest,
  markRequestPaid,
  getPaymentRequestById,
  formatRequestsMenu,
  formatRequestPaidNotice,
} = require('./paymentRequests');
const { getDexConfig, resolveToken, tokenLabel, quoteSwap, getFlzPrice } = require('./dex');
const { notifyPhone, notifyAccount } = require('./notify');

const PENDING_TTL_MS = config.pendingTtlMs;
const ADMIN_PHONES = config.adminPhones;

const USER_COLS =
  'id, phone, wallet_address, balance_eth, is_admin, display_name, created_at, account_id';

// ---------------------------------------------------------------------------
// Pending flows (in memory, keyed by ctx.key so channels never collide)
// ---------------------------------------------------------------------------

/** @type {Map<string, { plan: object, createdAt: number, paymentRequestId?: string|null }>} */
const pendingSends = new Map();

/** @type {Map<string, { address: string, createdAt: number }>} */
const pendingWalletAdds = new Map();

/** @type {Map<string, { mode: string, claims?: object[], requests?: object[], createdAt: number, awaitConfirmId?: string }>} */
const pendingClaimMenus = new Map();

/** @type {Map<string, { createdAt: number }>} */
const pendingUnlocks = new Map();

function pruneExpiredPending() {
  const now = Date.now();
  for (const [key, pending] of pendingSends.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) pendingSends.delete(key);
  }
  for (const [key, pending] of pendingWalletAdds.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) pendingWalletAdds.delete(key);
  }
  for (const [key, menu] of pendingClaimMenus.entries()) {
    if (now - menu.createdAt > PENDING_TTL_MS) pendingClaimMenus.delete(key);
  }
  for (const [key, wait] of pendingUnlocks.entries()) {
    if (now - wait.createdAt > PENDING_TTL_MS) pendingUnlocks.delete(key);
  }
}

/**
 * Throw away every half-finished flow on this channel.
 *
 * Called when the session locks. An in-flight flow does NOT survive a lock: the
 * person who would finish it is the one holding the phone, and a plan or a
 * trusted-wallet name step started before the lock is not something the owner
 * authorised after it. The hard-lock gate below refuses to advance a flow
 * anyway; this is the layer that means there is nothing left to advance.
 *
 * @param {string} key
 */
function discardPendingFlows(key) {
  pendingSends.delete(key);
  pendingWalletAdds.delete(key);
  pendingClaimMenus.delete(key);
  pendingUnlocks.delete(key);
}

/**
 * What the user is mid-way through. Clients use this to decide whether a bare
 * message (no prefix) is input rather than chatter.
 * @param {string} key
 */
function pendingFlowFor(key) {
  return {
    send: pendingSends.has(key),
    walletAdd: pendingWalletAdds.has(key),
    claimMenu: pendingClaimMenus.has(key),
    unlock: pendingUnlocks.has(key),
  };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * send 0.01 to 0x... | send 0.01 to ama | send 0.01 eth to ama
 * send 10 FLZ to ama | send 10 FLZ to 0x... (tokens → trusted only)
 * send 0.01 to github:octocat | send 0.01 eth to github:octocat
 * @returns {{
 *   amountEth: string,
 *   asset: string,
 *   toRaw: string,
 *   isAddress: boolean,
 *   isPhone: boolean,
 *   platform?: string|null,
 * } | null}
 */
function parseSendCommand(text) {
  const t = String(text || '').trim();

  // Explicit asset: send 10 FLZ to ...
  const assetAddr = t.match(
    /^send\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+(0x[a-fA-F0-9]{40})\b/i
  );
  if (assetAddr) {
    return {
      amountEth: assetAddr[1],
      asset: normalizeSendAsset(assetAddr[2]),
      toRaw: assetAddr[3],
      isAddress: true,
      isPhone: false,
      platform: null,
    };
  }
  const assetPhone = t.match(
    /^send\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+(\+?\d{10,15})\b/i
  );
  if (assetPhone) {
    return {
      amountEth: assetPhone[1],
      asset: normalizeSendAsset(assetPhone[2]),
      toRaw: assetPhone[3],
      isAddress: false,
      isPhone: true,
      platform: null,
    };
  }
  // Platform before bare alias: "to @user on github" and "to github:user"
  const assetGithubOn = t.match(
    /^send\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+@?([a-zA-Z0-9-]{1,39})\s+on\s+github\b/i
  );
  if (assetGithubOn) {
    return {
      amountEth: assetGithubOn[1],
      asset: normalizeSendAsset(assetGithubOn[2]),
      toRaw: assetGithubOn[3],
      isAddress: false,
      isPhone: false,
      platform: 'github',
    };
  }
  const assetGithubColon = t.match(
    /^send\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+github:([a-zA-Z0-9-]{1,39})\b/i
  );
  if (assetGithubColon) {
    return {
      amountEth: assetGithubColon[1],
      asset: normalizeSendAsset(assetGithubColon[2]),
      toRaw: assetGithubColon[3],
      isAddress: false,
      isPhone: false,
      platform: 'github',
    };
  }
  const assetAlias = t.match(
    /^send\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z][a-zA-Z0-9]{0,9})\s+to\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\b/i
  );
  if (assetAlias) {
    return {
      amountEth: assetAlias[1],
      asset: normalizeSendAsset(assetAlias[2]),
      toRaw: assetAlias[3],
      isAddress: false,
      isPhone: false,
      platform: null,
    };
  }

  // Native ETH (optional "eth" word)
  const addr = t.match(/^send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(0x[a-fA-F0-9]{40})\b/i);
  if (addr) {
    return {
      amountEth: addr[1],
      asset: 'ETH',
      toRaw: addr[2],
      isAddress: true,
      isPhone: false,
      platform: null,
    };
  }
  const phone = t.match(/^send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(\+?\d{10,15})\b/i);
  if (phone) {
    return {
      amountEth: phone[1],
      asset: 'ETH',
      toRaw: phone[2],
      isAddress: false,
      isPhone: true,
      platform: null,
    };
  }
  // Preferred UX: send 0.001 to @rudazy on github
  const githubOn = t.match(
    /^send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+@?([a-zA-Z0-9-]{1,39})\s+on\s+github\b/i
  );
  if (githubOn) {
    return {
      amountEth: githubOn[1],
      asset: 'ETH',
      toRaw: githubOn[2],
      isAddress: false,
      isPhone: false,
      platform: 'github',
    };
  }
  // Shorthand still accepted: send 0.001 to github:rudazy
  const githubColon = t.match(
    /^send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+github:([a-zA-Z0-9-]{1,39})\b/i
  );
  if (githubColon) {
    return {
      amountEth: githubColon[1],
      asset: 'ETH',
      toRaw: githubColon[2],
      isAddress: false,
      isPhone: false,
      platform: 'github',
    };
  }
  const alias = t.match(
    /^send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\b/i
  );
  if (alias) {
    return {
      amountEth: alias[1],
      asset: 'ETH',
      toRaw: alias[2],
      isAddress: false,
      isPhone: false,
      platform: null,
    };
  }
  return null;
}

function normalizeSendAsset(raw) {
  const s = String(raw || 'ETH').toUpperCase();
  if (s === 'ETH' || s === 'NATIVE' || s === 'ETHER') return 'ETH';
  if (s === 'FLIZY') return 'FLZ';
  return s;
}

function isNativeSendAsset(asset) {
  const s = String(asset || 'ETH').toUpperCase();
  return s === 'ETH' || s === 'NATIVE' || s === 'ETHER';
}

/**
 * buy 0.01 FLZ | sell 10 FLZ | swap 0.01 ETH for FLZ | price FLZ
 * @returns {{ kind: 'buy'|'sell'|'swap'|'price', amount?: string, tokenIn?: string, tokenOut?: string, symbol?: string } | null}
 */
function parseSwapCommand(text) {
  const t = String(text || '').trim();
  let m = t.match(/^price\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) return { kind: 'price', symbol: m[1] };

  m = t.match(/^buy\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) return { kind: 'buy', amount: m[1], tokenOut: m[2] };

  m = t.match(/^sell\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) return { kind: 'sell', amount: m[1], tokenIn: m[2] };

  m = t.match(/^swap\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s+for\s+([a-zA-Z0-9]+)\s*$/i);
  if (m) return { kind: 'swap', amount: m[1], tokenIn: m[2], tokenOut: m[3] };

  return null;
}

/** cancel claims | cancel claims 234... | cancel claims all */
function parseCancelClaimsCommand(text) {
  const m = String(text || '')
    .trim()
    .match(/^cancel\s+claims?(?:\s+(\+?\d{6,20}|all))?\s*$/i);
  if (!m) return null;
  const arg = m[1] ? String(m[1]).toLowerCase() : null;
  return { filter: arg === 'all' ? null : arg };
}

/** claims (list outgoing) | claim / claim incoming */
function parseClaimsListCommand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'claims' || t === 'claim list' || t === 'outgoing claims') {
    return { kind: 'outgoing' };
  }
  if (t === 'claim' || t === 'claim incoming' || t === 'incoming claims' || t === 'my claims') {
    return { kind: 'incoming' };
  }
  return null;
}

/** request 0.01 from 234… | request 0.01 from john */
function parseRequestCommand(text) {
  const phone = String(text || '').match(
    /^request\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+from\s+(\+?\d{10,15})\s*$/i
  );
  if (phone) {
    return { amountEth: phone[1], fromRaw: phone[2], isPhone: true };
  }
  const name = String(text || '').match(
    /^request\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+from\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\s*$/i
  );
  if (name) {
    return { amountEth: name[1], fromRaw: name[2], isPhone: false };
  }
  return null;
}

/** requests | pay | cancel requests */
function parseRequestsCommand(text) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'requests' || t === 'my requests' || t === 'cancel requests') {
    return { kind: t === 'cancel requests' ? 'cancel_out' : 'outgoing' };
  }
  if (t === 'pay' || t === 'pay request' || t === 'pay requests' || t === 'incoming requests') {
    return { kind: 'incoming' };
  }
  return null;
}

/** save ama 0x... | add ama 0x... | contact ama 0x... */
function parseSaveContactCommand(text) {
  const m = String(text || '').match(
    /^(?:save|add|contact)\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\s+(0x[a-fA-F0-9]{40})\s*$/i
  );
  if (!m) return null;
  return { alias: m[1].toLowerCase(), address: m[2] };
}

/** remove ama | unsave ama | delete ama */
function parseRemoveContactCommand(text) {
  const m = String(text || '').match(/^(?:remove|unsave|delete)\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\s*$/i);
  if (!m) return null;
  return { alias: m[1].toLowerCase() };
}

/** add wallet 0x... | add 0x... */
function parseAddWalletCommand(text) {
  const m = String(text || '').match(/^add(?:\s+wallet)?\s+(0x[a-fA-F0-9]{40})\s*$/i);
  if (!m) return null;
  return { address: m[1] };
}

function isValidTrustedName(name) {
  return /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(String(name || '').trim());
}

/** credit 234xxx 0.01 | credit 0.01 to 234xxx */
function parseCreditCommand(text) {
  let m = String(text || '').match(/^credit\s+(\d{6,20})\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s*$/i);
  if (m) return { phone: m[1], amountEth: m[2] };
  m = String(text || '').match(/^credit\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(\d{6,20})\s*$/i);
  if (m) return { phone: m[2], amountEth: m[1] };
  return null;
}

/** claimadmin <secret> promotes yourself if ADMIN_SETUP_SECRET matches */
function parseClaimAdminCommand(text) {
  const m = String(text || '').match(/^claimadmin\s+(\S+)\s*$/i);
  if (!m) return null;
  return { secret: m[1] };
}

/** link A7K2QX (body after prefix is stripped) */
function parseLinkCommand(text) {
  const m = String(text || '').match(/^link\s+([A-Za-z0-9]{6,12})\s*$/i);
  if (!m) return null;
  return { code: m[1].toUpperCase() };
}

const isConfirmCommand = (text) => String(text || '').trim().toLowerCase() === 'confirm';
const isCancelCommand = (text) => String(text || '').trim().toLowerCase() === 'cancel';

function isOneOf(text, words) {
  return words.includes(String(text || '').trim().toLowerCase());
}

const isHelpCommand = (t) => isOneOf(t, ['help', 'start', 'menu', 'flizy']);
const isBalanceCommand = (t) => isOneOf(t, ['balance', 'bal']);
const isDepositCommand = (t) => isOneOf(t, ['deposit', 'fund', 'topup', 'top up']);
const isHistoryCommand = (t) => isOneOf(t, ['history', 'txs', 'transfers']);
const isMeCommand = (t) => isOneOf(t, ['me', 'whoami', 'account']);
const isPoolCommand = (t) => isOneOf(t, ['pool', 'hotwallet', 'botbalance']);
const isEscrowCommand = (t) => isOneOf(t, ['escrow', 'claims escrow', 'claimescrow']);
const isUsersCommand = (t) => isOneOf(t, ['users', 'listusers']);
const isHowCommand = (t) => isOneOf(t, ['how', 'howto', 'how to', 'invite', 'share']);
const isContactsListCommand = (t) => isOneOf(t, ['contacts', 'list', 'names', 'addressbook']);
const isPhoneShareCommand = (t) => isOneOf(t, ['phone', 'share phone', 'sharephone', 'verify phone']);

/** Command body after any prefix is stripped. */
function isFlizyCommandBody(body) {
  const t = String(body || '').trim();
  if (!t) return false;
  return (
    isHelpCommand(t) ||
    isHowCommand(t) ||
    isBalanceCommand(t) ||
    isDepositCommand(t) ||
    isHistoryCommand(t) ||
    isMeCommand(t) ||
    isPoolCommand(t) ||
    isEscrowCommand(t) ||
    isUsersCommand(t) ||
    isContactsListCommand(t) ||
    isPhoneShareCommand(t) ||
    isConfirmCommand(t) ||
    isCancelCommand(t) ||
    Boolean(parseSendCommand(t)) ||
    Boolean(parseSwapCommand(t)) ||
    Boolean(parseCancelClaimsCommand(t)) ||
    Boolean(parseClaimsListCommand(t)) ||
    Boolean(parseRequestCommand(t)) ||
    Boolean(parseRequestsCommand(t)) ||
    Boolean(parseCreditCommand(t)) ||
    Boolean(parseClaimAdminCommand(t)) ||
    Boolean(parseSaveContactCommand(t)) ||
    Boolean(parseRemoveContactCommand(t)) ||
    Boolean(parseAddWalletCommand(t)) ||
    Boolean(parseLinkCommand(t)) ||
    Boolean(parseUnlockCommand(t)) ||
    parseLockCommand(t)
  );
}

/**
 * Raw chat text that should wake the bot.
 * WhatsApp normally requires the "flizy" prefix; bare confirm/cancel always work
 * so a pending plan is never stuck. Telegram uses /commands.
 */
function isFlizyCommand(ctx, text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isConfirmCommand(raw) || isCancelCommand(raw)) return true;
  if (/^flizy\b/i.test(raw)) {
    const stripped = stripFlizyPrefix(raw, { requirePrefix: true });
    return stripped.ok && (stripped.body === '' || isFlizyCommandBody(stripped.body));
  }
  if (normalizeChannel(ctx.channel) === CHANNELS.TELEGRAM) {
    if (raw.startsWith('/')) return true;
    return isFlizyCommandBody(raw);
  }
  if (config.requireFlizyPrefix) return false;
  return isFlizyCommandBody(raw);
}

/**
 * When hard-locked, only unlock (and the unlock reply) may run.
 * Link stays allowed so a locked user can re-bind if needed.
 */
function isAllowedWhenLocked(body) {
  return (
    Boolean(parseUnlockCommand(body)) ||
    Boolean(parseLinkCommand(body)) ||
    parseLockCommand(body)
  );
}

/**
 * What to say when unlock did not work.
 *
 * Three cases, one place, because both the one-shot and the interactive unlock
 * path render it. A locked-out user always gets the site route out, since
 * proving the password there is what clears the block.
 *
 * @param {object} ctx
 * @param {object} res result from unlockWithPin
 */
function unlockFailureText(ctx, res) {
  const resetHint = [
    `Forgot it? Set a new PIN with your account password: ${config.siteUrl}/dashboard/account`,
    'That clears the block immediately.',
  ];

  if (res.reason === 'pin_locked') {
    return [
      'Too many wrong attempts.',
      `Unlock is blocked on this ${channelName(ctx)} for about ${res.retryAfterText}.`,
      '',
      ...resetHint,
    ].join('\n');
  }

  if (res.lockedForMs > 0) {
    return [
      'Wrong password or PIN, once too often.',
      `Unlock is now blocked on this ${channelName(ctx)} for about ${res.retryAfterText}.`,
      '',
      ...resetHint,
    ].join('\n');
  }

  const lines = [
    'Unlock failed. Wrong password or PIN.',
    'Use your site login password, or the unlock PIN from Account.',
  ];
  if (res.attemptsLeft === 1) {
    lines.push('One more wrong attempt blocks unlock here for a while.');
  }
  lines.push(`Try again: ${cmd(ctx, 'unlock')}`);
  return lines.join('\n');
}

/**
 * Normalize raw chat text into a command body.
 * @returns {{ text: string, hadPrefix: boolean } | null} null = ignore silently
 */
function normalizeInput(ctx, rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;

  const flow = pendingFlowFor(ctx.key);
  const midFlow = flow.walletAdd || flow.claimMenu || flow.unlock;
  const telegram = normalizeChannel(ctx.channel) === CHANNELS.TELEGRAM;

  if (isConfirmCommand(raw) || isCancelCommand(raw)) {
    return { text: raw.toLowerCase(), hadPrefix: false };
  }

  if (telegram && raw.startsWith('/')) {
    // /send@FlizyBot 0.01 to john  →  send 0.01 to john
    const body = raw.slice(1).replace(/^([a-zA-Z_]+)@[\w_]+/, '$1').trim();
    const start = body.match(/^start(?:\s+(\S+))?$/i);
    if (start) {
      return { text: start[1] ? `link ${start[1]}` : 'help', hadPrefix: true };
    }
    return { text: body === '' ? 'help' : body, hadPrefix: true };
  }

  const stripped = stripFlizyPrefix(raw, {
    requirePrefix: telegram ? false : config.requireFlizyPrefix,
  });

  if (!stripped.ok) {
    // No prefix and prefix required: only mid-flow bare replies get through
    return midFlow ? { text: raw, hadPrefix: false } : null;
  }

  if (stripped.hadPrefix) {
    return { text: stripped.body === '' ? 'help' : stripped.body, hadPrefix: true };
  }

  // Bare text: a command body, or mid-flow input (wallet name, PIN, menu pick)
  if (isFlizyCommandBody(stripped.body)) {
    return { text: stripped.body, hadPrefix: false };
  }
  if (midFlow) {
    return { text: raw, hadPrefix: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function formatEth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  if (n < 0.000001) return n.toExponential(4);
  return n.toFixed(6).replace(/\.?0+$/, '');
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

/** Render a command the way this channel expects it to be typed. */
function cmd(ctx, body) {
  return isTelegram(ctx) ? `/${body}` : `flizy ${body}`;
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
    return await ctx.reply(String(text), opts);
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

// ---------------------------------------------------------------------------
// Users / accounts
// ---------------------------------------------------------------------------

/**
 * Legacy users row key for a channel identity.
 * WhatsApp keeps its bare sender id so every historic row still matches.
 */
function legacyUserKey(ctx) {
  return transferKey(ctx);
}

/**
 * Absolute set of a user's credit. Admin top-ups only.
 *
 * Spending credit does NOT go through here. A send reserves its amount with the
 * guarded decrement in lib/credit.js, because an absolute write computed from an
 * earlier read loses one of two concurrent debits.
 */
async function setUserBalance(userId, newBalanceEth) {
  const { data, error } = await supabase
    .from('users')
    .update({ balance_eth: newBalanceEth })
    .eq('id', userId)
    .select(USER_COLS)
    .single();
  if (error) throw new Error(`Balance update failed: ${error.message}`);
  return data;
}

/**
 * The legacy users row backing this identity.
 *
 * When the account is already linked, every channel shares the one row bound to
 * that account, so credit and admin never diverge between WhatsApp and Telegram.
 *
 * @param {object} ctx
 * @param {string|null} accountId
 */
async function resolveLegacyUser(ctx, accountId) {
  if (accountId) {
    const { data, error } = await supabase
      .from('users')
      .select(USER_COLS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1);
    if (!error && data && data.length) {
      return { user: data[0], isNew: false };
    }
  }

  const key = legacyUserKey(ctx);
  const { data: existing, error: selectError } = await supabase
    .from('users')
    .select(USER_COLS)
    .eq('phone', key)
    .maybeSingle();
  if (selectError) throw new Error(`Supabase select users failed: ${selectError.message}`);

  if (existing) {
    if (ADMIN_PHONES.has(normalizePhoneNumber(key)) && !existing.is_admin) {
      const { data: promoted, error: promoErr } = await supabase
        .from('users')
        .update({ is_admin: true })
        .eq('id', existing.id)
        .select(USER_COLS)
        .single();
      if (!promoErr && promoted) return { user: promoted, isNew: false };
    }
    return { user: existing, isNew: false };
  }

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({
      phone: key,
      account_id: accountId || null,
      is_admin: ADMIN_PHONES.has(normalizePhoneNumber(key)),
      balance_eth: 0,
    })
    .select(USER_COLS)
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      const { data: raced, error: raceError } = await supabase
        .from('users')
        .select(USER_COLS)
        .eq('phone', key)
        .single();
      if (raceError) throw new Error(`Supabase reselect users failed: ${raceError.message}`);
      return { user: raced, isNew: false };
    }
    throw new Error(`Supabase insert users failed: ${insertError.message}`);
  }

  return { user: created, isNew: true };
}

/**
 * Always show the permanent site agent wallet after link.
 * An unlinked identity must not invent a second address.
 */
async function resolveLinkedSiteAccount(ctx, account) {
  const linked = await getAccountByIdentity(ctx.channel, ctx.externalId);
  if (linked?.account?.email) {
    return ensureAgentWallet(linked.account.id);
  }
  if (account?.email) {
    return ensureAgentWallet(account.id);
  }
  return null;
}

async function requireLinkedSite(ctx, account) {
  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(
      ctx,
      [
        'Link your site account first.',
        `Open ${config.siteUrl}/dashboard`,
        'Generate a code, then send:',
        cmd(ctx, 'link CODE'),
      ].join('\n')
    );
    return null;
  }
  return siteAcc;
}

async function actorSessionFlags(ctx, user, siteAcc) {
  let sessionUnlocked = true;
  if (config.requireUnlock && siteAcc.unlock_pin_hash && !isAdminUser(user)) {
    sessionUnlocked = await isSessionUnlocked(siteAcc.id, ctx.channel, ctx.externalId);
  }
  return {
    accountId: siteAcc.id,
    userId: user.id,
    waSenderId: transferKey(ctx),
    isAdmin: isAdminUser(user),
    creditEth: Number(user.balance_eth || 0),
    sessionUnlocked,
    hasPin: Boolean(siteAcc.unlock_pin_hash),
  };
}

/**
 * Phone join key for claims/requests on this identity.
 * Uses only channel-verified numbers, and stores what it learns.
 *
 * waSenderId is the LEGACY claim key, not the transfer key. It is only ever the
 * bare WhatsApp sender id, because in the @c.us era that id really was the
 * user's phone. A Telegram user id must never be treated as a phone: strip its
 * namespace and a 10-digit Telegram id would match a stranger's claim.
 *
 * @returns {Promise<{ waSenderId: string, waPhone: string|null }>}
 */
async function resolveClaimIdentity(ctx) {
  let phone = null;

  if (typeof ctx.resolveVerifiedPhone === 'function') {
    try {
      phone = await ctx.resolveVerifiedPhone();
    } catch (err) {
      console.warn('resolveVerifiedPhone:', publicErrorMessage(err));
    }
  }

  if (phone && isPlausiblePhone(phone)) {
    try {
      const res = await setIdentityPhone(ctx.channel, ctx.externalId, phone);
      if (!res.ok && res.reason === 'phone_taken') {
        console.warn(`[identity] phone ${maskPhone(phone)} belongs to another account`);
        phone = null;
      }
    } catch (err) {
      console.warn('setIdentityPhone:', publicErrorMessage(err));
    }
  } else {
    phone = null;
  }

  // Every identity this account has proven, which is what makes a platform
  // claim findable: such a claim is addressed to one of these rows, and a row
  // only exists because the recipient completed a link.
  let identities = [];
  try {
    const bound = await getAccountByIdentity(ctx.channel, ctx.externalId);
    if (!phone && bound?.identity?.phone_e164) {
      phone = normalizePhoneNumber(bound.identity.phone_e164);
    }
    if (bound?.account?.id) {
      identities = await listIdentitiesForAccount(bound.account.id);
    }
  } catch (err) {
    console.warn('resolveClaimIdentity lookup:', publicErrorMessage(err));
  }

  return {
    // Allowlist, not "everything except Telegram": the legacy key is only
    // meaningful on WhatsApp, and a new channel must not inherit it by default.
    waSenderId: normalizeChannel(ctx.channel) === CHANNELS.WHATSAPP ? ctx.externalId : '',
    waPhone: phone || null,
    identities,
  };
}

// ---------------------------------------------------------------------------
// Contacts (chat address book; the site trusted list is the policy source)
// ---------------------------------------------------------------------------

/** Every chat id this account owns, so an address book is shared across channels. */
async function ownerKeysForAccount(ctx, accountId) {
  const keys = new Set([ctx.externalId]);
  if (accountId) {
    const { data } = await supabase
      .from('channel_identities')
      .select('external_id')
      .eq('account_id', accountId);
    for (const row of data || []) {
      if (row.external_id) keys.add(row.external_id);
    }
  }
  return [...keys];
}

/**
 * Resolve 0x... or a name from:
 * 1) chat contacts saved by this account (any channel)
 * 2) site trusted_addresses.label (dashboard)
 */
async function resolveSendTarget(ctx, toRaw, isAddress, accountId) {
  if (isAddress) {
    if (!ethers.isAddress(toRaw)) return { error: 'Invalid address.' };
    return { address: ethers.getAddress(toRaw), label: null };
  }

  const alias = String(toRaw).toLowerCase();
  const owners = await ownerKeysForAccount(ctx, accountId);

  const { data: contacts, error: cErr } = await supabase
    .from('contacts')
    .select('alias, address, owner_phone')
    .in('owner_phone', owners)
    .eq('alias', alias)
    .limit(1);
  if (cErr) return { error: `Contact lookup failed: ${cErr.message}` };

  const contact = contacts && contacts.length ? contacts[0] : null;
  if (contact && ethers.isAddress(contact.address)) {
    return { address: ethers.getAddress(contact.address), label: contact.alias };
  }

  if (accountId) {
    const { data: trustedRows, error: tErr } = await supabase
      .from('trusted_addresses')
      .select('address, label')
      .eq('account_id', accountId);
    if (tErr) return { error: `Trusted lookup failed: ${tErr.message}` };

    const match = (trustedRows || []).find(
      (r) => String(r.label || '').trim().toLowerCase() === alias
    );
    if (match && ethers.isAddress(match.address)) {
      return { address: ethers.getAddress(match.address), label: match.label || alias };
    }
  }

  return {
    error: [
      `No contact or trusted name "${alias}".`,
      `Site: add label "${alias}" under Trusted addresses, or`,
      `Chat: ${cmd(ctx, `save ${alias} 0xYourAddress`)}`,
      `List: ${cmd(ctx, 'contacts')}`,
    ].join('\n'),
  };
}

async function saveContact(user, ownerKey, alias, address) {
  if (!ethers.isAddress(address)) {
    throw new Error('Invalid address. Use 0x + 40 hex characters.');
  }
  const checksum = ethers.getAddress(address);
  const { data, error } = await supabase
    .from('contacts')
    .upsert(
      {
        user_id: user.id,
        owner_phone: ownerKey,
        alias: alias.toLowerCase(),
        address: checksum,
      },
      { onConflict: 'owner_phone,alias' }
    )
    .select('alias, address')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function removeContact(ownerKeys, alias) {
  const { data, error } = await supabase
    .from('contacts')
    .delete()
    .in('owner_phone', ownerKeys)
    .eq('alias', alias.toLowerCase())
    .select('alias')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function listContacts(ownerKeys) {
  const { data, error } = await supabase
    .from('contacts')
    .select('alias, address')
    .in('owner_phone', ownerKeys)
    .order('alias', { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function howOthersUseText(ctx) {
  if (isTelegram(ctx)) {
    return [
      'How others use Flizy',
      '',
      '1. Share this Telegram bot with a friend.',
      '2. They open the bot and press Start.',
      '3. They create an account on the site and link it:',
      '     /link CODE',
      '4. They send from Telegram:',
      '     /send 0.001 to nald',
      '     confirm',
      '',
      'Trusted names are managed on the site only.',
      `Site: ${config.siteUrl}`,
    ].join('\n');
  }

  const numberLine = config.botWhatsAppNumber
    ? `Bot number: +${config.botWhatsAppNumber}`
    : 'Bot number: the WhatsApp that linked this bot (see terminal on start)';

  return [
    'How others use Flizy',
    '',
    '1. Share the bot WhatsApp number with friends.',
    `   ${numberLine}`,
    '2. They open WhatsApp and message that number (not a group).',
    '3. First message auto-registers them.',
    '4. They send from WhatsApp (no admin step):',
    '     flizy send 0.001 to nald',
    '     flizy confirm',
    '',
    'Trusted names are managed on the site only.',
    'Only message the Flizy bot number (or Message yourself).',
  ].join('\n');
}

/**
 * Everyday help in chat — short Web2 list only.
 * Full command list: site /docs. No chain/gas/RPC here.
 */
function helpText(ctx) {
  const p = (body) => cmd(ctx, body);
  const how = isTelegram(ctx)
    ? 'Type a command with / or the same words.'
    : 'Start each command with: flizy';

  return [
    'Flizy — send money like a message.',
    '',
    how,
    '',
    `  ${p('send 0.01 to john')}   pay someone you trust`,
    `  ${p('send 0.01 to 2348012345678')}   send to a phone`,
    '  confirm                 yes, go ahead',
    '  cancel                  no, stop',
    `  ${p('claim')}               receive money held for you`,
    `  ${p('balance')}             what you have`,
    `  ${p('link CODE')}           connect your site account`,
    `  ${p('lock')} / ${p('unlock')}   freeze or open this chat`,
    '',
    `Visit ${config.siteUrl}/docs for the full Flizy command list.`,
  ].join('\n');
}

function welcomeText(ctx, user) {
  return [
    'Welcome to Flizy',
    '',
    'Send money like a message — to people you trust, a phone, or GitHub.',
    '',
    isTelegram(ctx)
      ? 'Try these (slash commands work too):'
      : 'On WhatsApp, prefix with flizy. Try:',
    `  ${cmd(ctx, 'help')}     short guide`,
    `  ${cmd(ctx, 'send 0.001 to ama')}   pay a trusted name`,
    `  ${cmd(ctx, 'lock')}     freeze this chat`,
    '',
    `Dashboard: ${config.siteUrl}/dashboard`,
    `All commands: ${config.siteUrl}/docs`,
  ].join('\n');
}

/** Command list for a channel that shows a menu (Telegram setMyCommands). */
function commandMenu() {
  return [
    { command: 'help', description: 'Simple guide — full list on the site' },
    { command: 'link', description: 'Connect site account with a code' },
    { command: 'me', description: 'Your linked account' },
    { command: 'balance', description: 'What you have' },
    { command: 'deposit', description: 'How to add funds' },
    { command: 'history', description: 'Recent activity' },
    { command: 'send', description: 'Pay a name, phone, or GitHub' },
    { command: 'request', description: 'Ask someone for money' },
    { command: 'pay', description: 'Pay a request to you' },
    { command: 'claim', description: 'Receive money held for you' },
    { command: 'claims', description: 'Holds you sent' },
    { command: 'buy', description: 'Optional: buy FLZ' },
    { command: 'sell', description: 'Optional: sell FLZ' },
    { command: 'swap', description: 'Optional: swap tokens' },
    { command: 'price', description: 'Optional: FLZ price' },
    { command: 'contacts', description: 'Saved names' },
    { command: 'phone', description: 'Share number for phone claims' },
    { command: 'lock', description: 'Freeze Flizy on this chat' },
    { command: 'unlock', description: 'Unlock with PIN or password' },
  ];
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleMe(ctx, user, account) {
  try {
    const acc = await resolveLinkedSiteAccount(ctx, account);
    if (!acc) {
      await reply(
        ctx,
        [
          'Link your site account to see your permanent agent wallet.',
          `Site: ${config.siteUrl}/dashboard`,
          `Generate a code, then: ${cmd(ctx, 'link CODE')}`,
          '',
          `${channelName(ctx)} id: ${ctx.externalId}`,
        ].join('\n')
      );
      return;
    }

    const bound = await getAccountByIdentity(ctx.channel, ctx.externalId);
    const phone = bound?.identity?.phone_e164 || null;

    await reply(
      ctx,
      [
        'Your Flizy account',
        acc.email ? `Email: ${acc.email}` : null,
        acc.display_name ? `Name: ${acc.display_name}` : null,
        `Agent wallet: ${acc.agent_wallet_address}`,
        `${channelName(ctx)} id: ${ctx.externalId}`,
        phone ? `Claim number: +${phone}` : `Claim number: not shared (${cmd(ctx, 'phone')})`,
        '',
        `Tip: ${cmd(ctx, 'balance')}  |  ${cmd(ctx, 'history')}`,
      ]
        .filter(Boolean)
        .join('\n')
    );
  } catch (err) {
    console.error('me error:', publicErrorMessage(err));
    await reply(
      ctx,
      [
        'Your Flizy account',
        `${channelName(ctx)} id: ${ctx.externalId}`,
        `Could not load wallet. Try ${cmd(ctx, 'link CODE')} from the dashboard.`,
      ].join('\n')
    );
  }
}

async function handleDeposit(ctx, user, account) {
  // User asked how to fund — show the receive address. Still no RPC/gas/chain-ID lecture.
  const lines = [
    'Add funds',
    '',
    'Money you send from chat leaves the balance linked to your Flizy account.',
    'Easiest path: open the dashboard Fund steps (faucet → bridge → send to your address).',
    `  ${config.siteUrl}/dashboard/wallet?s=fund`,
    '',
  ];
  try {
    const acc = await resolveLinkedSiteAccount(ctx, account);
    if (acc?.agent_wallet_address) {
      lines.push('Your receive address (copy carefully):');
      lines.push(acc.agent_wallet_address);
      const bal = await provider.getBalance(acc.agent_wallet_address);
      lines.push(`Current balance: ${formatEth(ethers.formatEther(bal))} ETH`);
    } else {
      lines.push(`Link your site account first: ${config.siteUrl}/dashboard`);
      lines.push(`Then: ${cmd(ctx, 'link CODE')}`);
    }
  } catch {
    lines.push(`Could not load your address. Try ${cmd(ctx, 'me')}`);
  }
  lines.push(
    '',
    'After funds arrive:',
    '  1) Add trusted people on the site (password required)',
    `  2) ${cmd(ctx, 'send 0.0001 to name')}`,
    '  3) confirm',
    '',
    `All commands: ${config.siteUrl}/docs`
  );
  await reply(ctx, lines.join('\n'));
}

async function handleBalance(ctx, user, account) {
  try {
    const acc = await resolveLinkedSiteAccount(ctx, account);
    if (!acc) {
      await reply(
        ctx,
        [
          'Link your site account to see your permanent agent wallet.',
          `Site: ${config.siteUrl}/dashboard`,
          `Generate a code, then: ${cmd(ctx, 'link CODE')}`,
        ].join('\n')
      );
      return;
    }
    const credit = formatEth(acc?.balance_eth != null ? acc.balance_eth : user.balance_eth);
    let holdings = null;
    if (acc?.agent_wallet_address) {
      holdings = await getWalletHoldings(acc.agent_wallet_address, chain);
    }
    await reply(
      ctx,
      formatHoldingsMessage({
        credit,
        agentWallet: acc?.agent_wallet_address || null,
        holdings,
        showCredit: config.enforceCredit,
      })
    );
  } catch (err) {
    console.error('balance error:', publicErrorMessage(err));
    await reply(
      ctx,
      `Your credit: ${formatEth(user.balance_eth)} ETH\n(Could not read holdings right now.)`
    );
  }
}

async function handleHistory(ctx, account) {
  const accountId = account?.id || null;
  const key = transferKey(ctx);
  const selectCols =
    'id, amount_eth, to_address, status, tx_hash, created_at, kind, asset, amount_secondary, asset_secondary, counterparty_label, direction';

  let query = supabase
    .from('transfers')
    .select(selectCols)
    .order('created_at', { ascending: false })
    .limit(30);

  if (accountId) {
    query = query.or(`account_id.eq.${accountId},phone.eq.${key}`);
  } else {
    query = query.eq('phone', key);
  }

  let { data, error } = await query;
  if (error) {
    // Older schema without the newer columns
    const fallback = await supabase
      .from('transfers')
      .select('id, amount_eth, to_address, status, tx_hash, created_at, kind')
      .eq(accountId ? 'account_id' : 'phone', accountId || key)
      .order('created_at', { ascending: false })
      .limit(30);
    data = fallback.data;
    error = fallback.error;
  }

  const items = [];
  for (const row of data || []) {
    const kind = String(row.kind || 'transfer').toLowerCase();
    const asset = String(row.asset || 'ETH').toUpperCase();
    const amt = formatEth(row.amount_eth);
    if (kind === 'swap') {
      const out =
        row.amount_secondary && row.asset_secondary
          ? ` → ${formatEth(row.amount_secondary)} ${row.asset_secondary}`
          : '';
      items.push({
        created: row.created_at,
        line: `• Swap ${amt} ${asset}${out} [${row.status}]`,
        tx: row.tx_hash,
      });
    } else {
      const dest = row.counterparty_label || shortAddress(row.to_address);
      const dir = String(row.direction || 'out') === 'in' ? 'Recv' : 'Send';
      items.push({
        created: row.created_at,
        line: `• ${dir} ${amt} ${asset} → ${dest} [${row.status}]`,
        tx: row.tx_hash,
      });
    }
  }

  if (accountId) {
    try {
      const { data: claimsOut } = await supabase
        .from('claims')
        .select(
          'amount_eth, status, to_wa_hint, to_channel, to_external_id, to_display_handle, hold_tx_hash, refund_tx_hash, claim_tx_hash, created_at, claimed_at'
        )
        .eq('from_account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(15);
      for (const c of claimsOut || []) {
        items.push({
          created: c.claimed_at || c.created_at,
          line: `• ${formatClaimHistoryLabel(c, { role: 'sender', status: c.status })}`,
          tx: c.claim_tx_hash || c.refund_tx_hash || c.hold_tx_hash,
        });
      }
      const { data: claimsIn } = await supabase
        .from('claims')
        .select(
          'amount_eth, status, to_wa_hint, to_channel, to_external_id, to_display_handle, claim_tx_hash, hold_tx_hash, created_at, claimed_at'
        )
        .eq('to_account_id', accountId)
        .eq('status', 'claimed')
        .order('claimed_at', { ascending: false })
        .limit(15);
      for (const c of claimsIn || []) {
        items.push({
          created: c.claimed_at || c.created_at,
          line: `• ${formatClaimHistoryLabel(c, { role: 'receiver', status: c.status })}`,
          tx: c.claim_tx_hash || null,
        });
      }
    } catch (err) {
      console.warn('history claims:', publicErrorMessage(err));
    }
  }

  items.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
  const top = items.slice(0, 30);

  if (error && top.length === 0) {
    console.error('history error:', error);
    await reply(ctx, 'Could not load history right now.');
    return;
  }

  if (top.length === 0) {
    await reply(
      ctx,
      [
        'No activity yet.',
        `Try: ${cmd(ctx, 'send 0.001 to john')}`,
        `Or: ${cmd(ctx, 'send 10 FLZ to john')}`,
        `Or: ${cmd(ctx, 'buy 0.01 FLZ')}`,
      ].join('\n')
    );
    return;
  }

  const lines = [`Last ${top.length} activity:`];
  for (const row of top) {
    lines.push(row.line);
    if (row.tx) lines.push(`  ${txUrl(row.tx)}`);
  }
  await reply(ctx, lines.join('\n'));
}

async function handlePool(ctx, user) {
  if (!isAdminUser(user)) {
    await reply(ctx, `Pool is admin-only. Use ${cmd(ctx, 'balance')} for your credit.`);
    return;
  }
  try {
    const pool = await getOpsBalanceEth();
    await reply(
      ctx,
      [
        'Ops wallet (gas / infra — not claim escrow)',
        `${formatEth(pool)} ETH`,
        opsWallet.address,
        addressUrl(opsWallet.address),
        '',
        `Claim escrow: ${cmd(ctx, 'escrow')}`,
      ].join('\n')
    );
  } catch (err) {
    console.error('pool error:', publicErrorMessage(err));
    await reply(ctx, 'Could not read pool balance.');
  }
}

async function handleEscrow(ctx, user) {
  if (!isAdminUser(user)) {
    await reply(ctx, 'Escrow status is admin-only.');
    return;
  }
  try {
    const text = await formatEscrowStatus(provider);
    await reply(ctx, [text, addressUrl(escrowWallet.address)].join('\n'));
  } catch (err) {
    console.error('escrow status:', publicErrorMessage(err));
    await reply(ctx, 'Could not read escrow status.');
  }
}

async function handleUsers(ctx, user) {
  if (!isAdminUser(user)) {
    await reply(ctx, 'Users list is admin-only.');
    return;
  }
  const { data, error } = await supabase
    .from('users')
    .select('phone, balance_eth, is_admin, created_at')
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) {
    await reply(ctx, 'Could not list users.');
    return;
  }
  if (!data?.length) {
    await reply(ctx, 'No users yet.');
    return;
  }

  const lines = ['Recent users:'];
  for (const u of data) {
    lines.push(`• ${u.phone}  credit=${formatEth(u.balance_eth)}  ${u.is_admin ? 'admin' : 'user'}`);
  }
  await reply(ctx, lines.join('\n'));
}

async function handleClaimAdmin(ctx, user, secret) {
  const expected = config.adminSetupSecret;
  if (!expected || expected === 'changeme') {
    await reply(
      ctx,
      'Admin setup is not configured.\nSet ADMIN_SETUP_SECRET in .env (not "changeme"), restart, then:\nclaimadmin your-secret'
    );
    return;
  }
  if (secret !== expected) {
    await reply(ctx, 'Invalid setup secret.');
    return;
  }
  if (user.is_admin) {
    await reply(ctx, 'You are already an admin.');
    return;
  }
  const { data, error } = await supabase
    .from('users')
    .update({ is_admin: true })
    .eq('id', user.id)
    .select('phone, is_admin')
    .single();
  if (error) {
    await reply(ctx, 'Could not promote. Try again.');
    return;
  }
  await reply(
    ctx,
    [
      'You are now an admin.',
      `Id: ${data.phone}`,
      '',
      'You can:',
      '  credit <id> 0.01',
      '  pool',
      '  users',
    ].join('\n')
  );
}

async function handleCredit(ctx, adminUser, targetPhone, amountEth) {
  if (!isAdminUser(adminUser)) {
    await reply(ctx, 'Only admins can credit balances.');
    return;
  }

  let amount;
  try {
    amount = Number(amountEth);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('bad amount');
    ethers.parseEther(String(amountEth));
  } catch {
    await reply(ctx, 'Invalid amount. Example: credit 2348012345678 0.01');
    return;
  }

  const key = normalizePhoneNumber(targetPhone);
  if (key.length < 6) {
    await reply(
      ctx,
      'Invalid id. Use digits with country code, no +.\nExample: credit 2348012345678 0.01'
    );
    return;
  }

  try {
    const { data: target, error } = await supabase
      .from('users')
      .select(USER_COLS)
      .eq('phone', key)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!target) {
      await reply(ctx, 'No such user yet. They must message the bot once first.');
      return;
    }
    const next = Number(target.balance_eth || 0) + amount;
    const updated = await setUserBalance(target.id, next);
    await reply(
      ctx,
      [
        'Credit added.',
        `User: ${updated.phone}`,
        `Added: ${formatEth(amount)} ETH`,
        `New credit: ${formatEth(updated.balance_eth)} ETH`,
      ].join('\n')
    );
  } catch (err) {
    console.error('credit error:', publicErrorMessage(err));
    await reply(ctx, 'Credit failed. Try again.');
  }
}

/**
 * SEND path: trusted/address on-chain OR phone/platform claim hold.
 * @param {string|null} [platform] e.g. 'github' for github:login targets
 */
async function handleSend(
  ctx,
  user,
  account,
  amountEth,
  toRaw,
  isAddress,
  isPhone,
  asset = 'ETH',
  platform = null
) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const sendAsset = normalizeSendAsset(asset);
  const native = isNativeSendAsset(sendAsset);
  const isPlatform = Boolean(platform);

  // Token claims to unlinked phones/platforms are not supported (escrow is ETH only)
  if ((isPhone || isPlatform) && !native) {
    await reply(
      ctx,
      [
        'Claim holds are ETH only for now.',
        `To send ${sendAsset}, add their wallet under Account → Trusted, then:`,
        cmd(ctx, `send ${amountEth} ${sendAsset} to theirname`),
      ].join('\n')
    );
    return;
  }

  // --- GitHub (and later other platforms): claim hold by immutable id ---
  if (platform === 'github') {
    await handleSendGithubClaim(ctx, user, siteAcc, amountEth, toRaw);
    return;
  }

  // --- Phone: always a claim hold ---
  if (isPhone) {
    const toWa = normalizeWaHint(toRaw);
    if (!isPlausiblePhone(toWa)) {
      await reply(
        ctx,
        `Invalid phone. Use country code digits.\nExample: ${cmd(ctx, 'send 0.001 to 2348012345678')}`
      );
      return;
    }

    const mine = await resolveClaimIdentity(ctx);
    const myNumbers = [mine.waPhone, mine.waSenderId]
      .filter(Boolean)
      .map((n) => normalizeWaHint(n));
    if (myNumbers.includes(toWa)) {
      await reply(ctx, 'You cannot send a claim to your own number.');
      return;
    }

    // The check above only knows the number on THIS channel. An account with
    // WhatsApp and Telegram linked could otherwise escrow to its own other
    // number and pay gas twice to move money in a circle. Degrades open: a
    // failed lookup is not a reason to block a legitimate send.
    try {
      const targetOwner = await findAccountIdByPhone(toWa);
      if (targetOwner && targetOwner === siteAcc.id) {
        await reply(
          ctx,
          'That number is on your own Flizy account. Send to someone else, or use it from that chat.'
        );
        return;
      }
    } catch (err) {
      console.warn('self-send check:', publicErrorMessage(err));
    }

    // A number always goes to escrow, whether or not it is already on Flizy.
    // Money never lands in someone's wallet unannounced: the recipient is
    // notified the moment the hold is placed and runs "claim" to take it, and
    // until they do the sender can still cancel.
    const actor = await actorSessionFlags(ctx, user, siteAcc);
    const intent = createSendIntent({
      actor,
      amountEth,
      toAddress: null,
      toLabel: `+${toWa}`,
      toRaw: toWa,
      toIsAddress: false,
      chainId: String(chain.chainId),
      asset: 'ETH',
    });

    const policy = await evaluateClaimHoldPolicy(intent, { accountRow: siteAcc });
    if (policy.decision === 'DENY') {
      await reply(ctx, policy.message || 'Not allowed.');
      return;
    }

    let fromAddress;
    let fromBalanceEth;
    try {
      const acc = await ensureAgentWallet(siteAcc.id);
      fromAddress = ethers.getAddress(acc.agent_wallet_address);
      fromBalanceEth = ethers.formatEther(await provider.getBalance(fromAddress));
    } catch (err) {
      console.error('agent balance check failed:', publicErrorMessage(err));
      await reply(ctx, 'Could not check your agent wallet. Try again shortly.');
      return;
    }

    const plan = buildClaimPlan({
      intent,
      policy,
      chain: {
        chainId: chain.chainId,
        chainName: chain.name,
        nativeSymbol: chain.nativeSymbol || 'ETH',
      },
      fromAddress,
      toWaHint: toWa,
      fromBalanceEth,
    });

    const funded = assertPlanFunded(
      { input: { amount: amountEth }, route: { fromAddress } },
      fromBalanceEth
    );
    if (!funded.ok) {
      await reply(ctx, [funded.message, addressUrl(fromAddress)].filter(Boolean).join('\n'));
      return;
    }

    pendingSends.set(ctx.key, { plan, createdAt: Date.now() });
    await reply(ctx, formatClaimPlanPreview(plan), { buttons: confirmButtons() });
    return;
  }

  // --- Address or trusted name ---
  const resolved = await resolveSendTarget(ctx, toRaw, isAddress, siteAcc.id);
  if (resolved.error) {
    await reply(ctx, resolved.error);
    return;
  }
  return handleSendResolved(ctx, user, amountEth, resolved, siteAcc, {
    skipTrusted: false,
    asset: sendAsset,
  });
}

/**
 * Hold ETH for a GitHub identity. Login is resolved to numeric id at plan time.
 */
async function handleSendGithubClaim(ctx, user, siteAcc, amountEth, loginRaw) {
  const login = normalizeGitHubLogin(loginRaw);
  if (!login) {
    await reply(
      ctx,
      [
        'Invalid GitHub username.',
        `Example: ${cmd(ctx, 'send 0.001 to @rudazy on github')}`,
      ].join('\n')
    );
    return;
  }

  let profile;
  try {
    profile = await resolveGitHubUser(login);
  } catch (err) {
    if (err && err.code === 'GITHUB_LOGIN_INVALID') {
      await reply(ctx, err.message);
      return;
    }
    if (err && err.code === 'GITHUB_RATE_LIMIT') {
      await reply(ctx, err.message);
      return;
    }
    console.warn('resolveGitHubUser:', publicErrorMessage(err));
    await reply(ctx, 'Could not look up that GitHub user. Try again shortly.');
    return;
  }
  if (!profile) {
    await reply(ctx, `No GitHub user named ${login}. Check the spelling.`);
    return;
  }

  let recipient;
  try {
    recipient = platformRecipient(CHANNELS.GITHUB, profile.id, profile.login);
  } catch (err) {
    await reply(ctx, err.message || 'Could not address that GitHub user.');
    return;
  }

  try {
    const bound = await getAccountByIdentity(CHANNELS.GITHUB, profile.id);
    if (bound?.account?.id && bound.account.id === siteAcc.id) {
      await reply(ctx, 'That GitHub account is linked to your own Flizy account.');
      return;
    }
  } catch (err) {
    console.warn('github self-send check:', publicErrorMessage(err));
  }

  const actor = await actorSessionFlags(ctx, user, siteAcc);
  const intent = createSendIntent({
    actor,
    amountEth,
    toAddress: null,
    toLabel: claimRecipientLabel(recipient),
    toRaw: `github:${profile.login}`,
    toIsAddress: false,
    chainId: String(chain.chainId),
    asset: 'ETH',
  });

  const policy = await evaluateClaimHoldPolicy(intent, { accountRow: siteAcc });
  if (policy.decision === 'DENY') {
    await reply(ctx, policy.message || 'Not allowed.');
    return;
  }

  let fromAddress;
  let fromBalanceEth;
  try {
    const acc = await ensureAgentWallet(siteAcc.id);
    fromAddress = ethers.getAddress(acc.agent_wallet_address);
    fromBalanceEth = ethers.formatEther(await provider.getBalance(fromAddress));
  } catch (err) {
    console.error('agent balance check failed:', publicErrorMessage(err));
    await reply(ctx, 'Could not check your agent wallet. Try again shortly.');
    return;
  }

  const plan = buildClaimPlan({
    intent,
    policy,
    chain: {
      chainId: chain.chainId,
      chainName: chain.name,
      nativeSymbol: chain.nativeSymbol || 'ETH',
    },
    fromAddress,
    recipient,
    fromBalanceEth,
  });

  const funded = assertPlanFunded(
    { input: { amount: amountEth }, route: { fromAddress } },
    fromBalanceEth
  );
  if (!funded.ok) {
    await reply(ctx, [funded.message, addressUrl(fromAddress)].filter(Boolean).join('\n'));
    return;
  }

  pendingSends.set(ctx.key, { plan, createdAt: Date.now() });
  await reply(ctx, formatClaimPlanPreview(plan), { buttons: confirmButtons() });
}

async function handleSendResolved(ctx, user, amountEth, resolved, siteAcc, opts = {}) {
  const sendAsset = normalizeSendAsset(opts.asset || 'ETH');
  const native = isNativeSendAsset(sendAsset);
  let tokenAddress = null;
  let tokenSymbol = null;
  let tokenBalance = null;

  if (!native) {
    try {
      tokenAddress = resolveToken(sendAsset, chain.id);
    } catch {
      tokenAddress = null;
    }
    if (!tokenAddress) {
      await reply(
        ctx,
        `Unknown token ${sendAsset}. Supported: ETH, FLZ.\nExample: ${cmd(ctx, 'send 10 FLZ to john')}`
      );
      return;
    }
    tokenSymbol = tokenLabel(sendAsset, chain.id) || sendAsset;
  }

  const actor = await actorSessionFlags(ctx, user, siteAcc);
  const intent = createSendIntent({
    actor,
    amountEth,
    toAddress: resolved.address,
    toLabel: resolved.label,
    toIsAddress: true,
    chainId: String(chain.chainId),
    asset: native ? 'native' : sendAsset,
  });

  const policy = await evaluateSendPolicy(intent, {
    enforceTrusted: opts.skipTrusted ? false : config.enforceTrusted,
    accountRow: siteAcc,
    nativeSymbol: chain.nativeSymbol || 'ETH',
  });
  if (policy.decision === 'DENY') {
    await reply(ctx, policy.message || 'Not allowed.');
    return;
  }

  let fromAddress;
  let fromBalanceEth;
  try {
    const acc = await ensureAgentWallet(siteAcc.id);
    fromAddress = ethers.getAddress(acc.agent_wallet_address);
    fromBalanceEth = ethers.formatEther(await provider.getBalance(fromAddress));
    if (tokenAddress) {
      const erc20 = new ethers.Contract(
        tokenAddress,
        [
          'function balanceOf(address) view returns (uint256)',
          'function decimals() view returns (uint8)',
        ],
        provider
      );
      const [bal, dec] = await Promise.all([erc20.balanceOf(fromAddress), erc20.decimals()]);
      tokenBalance = ethers.formatUnits(bal, Number(dec));
    }
  } catch (err) {
    console.error('agent balance check failed:', publicErrorMessage(err));
    await reply(ctx, 'Could not check your agent wallet on-chain. Try again shortly.');
    return;
  }

  const plan = buildSendPlan({
    intent,
    policy,
    chain: {
      chainId: chain.chainId,
      chainName: chain.name,
      nativeSymbol: chain.nativeSymbol || 'ETH',
    },
    fromAddress,
    fromBalanceEth,
    tokenAddress,
    tokenSymbol,
    tokenBalance,
  });
  if (opts.paymentRequestId) {
    plan.paymentRequestId = opts.paymentRequestId;
  }

  const funded = assertPlanFunded(plan, fromBalanceEth, config.gasBufferEth, { tokenBalance });
  if (!funded.ok) {
    await reply(ctx, [funded.message, addressUrl(fromAddress)].filter(Boolean).join('\n'));
    return;
  }

  pendingSends.set(ctx.key, {
    plan,
    createdAt: Date.now(),
    paymentRequestId: opts.paymentRequestId || null,
  });
  await reply(ctx, formatPlanPreview(plan), { buttons: confirmButtons() });
}

async function handleConfirm(ctx, user, account) {
  pruneExpiredPending();
  const pending = pendingSends.get(ctx.key);
  if (!pending) return;

  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingSends.delete(ctx.key);
    await reply(ctx, `Transfer plan expired. Start again with ${cmd(ctx, 'send ...')}`);
    return;
  }

  const plan = pending.plan;
  const paymentRequestId = pending.paymentRequestId || plan.paymentRequestId || null;
  pendingSends.delete(ctx.key);

  if (!plan) {
    await reply(ctx, `Nothing to confirm. Start with ${cmd(ctx, 'send ...')}`);
    return;
  }

  let fresh = user;
  try {
    const res = await resolveLegacyUser(ctx, plan.actor?.accountId || account?.id || null);
    fresh = res.user;
  } catch (err) {
    console.error('confirm re-fetch user:', publicErrorMessage(err));
  }

  if (plan.intent === 'CLAIM_HOLD') {
    await reply(ctx, 'Holding funds for claim...');
    const toWaHint = plan.route.toWaHint || plan.input.toWaHint;
    const recipient = plan.route.recipient || null;
    const isPlatform = plan.input.recipientKind === 'platform';

    // from_wa_sender is shown to the recipient as a phone number, so it may only
    // ever hold a real one. Passing the transfer key would write "telegram:123"
    // into a phone column, and the recipient would be told the money came from
    // a number that is not the sender's.
    const senderIdentity = await resolveClaimIdentity(ctx);

    const result = await executeClaimHold({
      fromAccountId: plan.actor.accountId,
      fromWaSender: senderIdentity.waPhone || null,
      toWaHint,
      recipient,
      amountEth: plan.input.amount,
      provider,
      chain,
      escrowWallet,
    });
    if (!result.ok) {
      await reply(ctx, result.error || 'Claim hold failed.');
      return;
    }

    let notified = false;
    if (isPlatform && recipient?.channel && recipient?.externalId) {
      notified = await notifyClaimPlatformTarget(
        ctx,
        recipient.channel,
        recipient.externalId,
        plan.input.amount,
        plan.actor?.accountId || null,
        senderIdentity
      );
    } else if (toWaHint) {
      notified = await notifyClaimTarget(
        ctx,
        toWaHint,
        plan.input.amount,
        plan.actor?.accountId || null,
        senderIdentity
      );
    }

    const howReceive = isPlatform
      ? notified
        ? 'They are on Flizy and have just been notified. They send flizy claim to receive.'
        : 'They receive after they link that GitHub on Flizy (Account → Link GitHub), then flizy claim.'
      : notified
        ? 'They are on Flizy and have just been notified. They send flizy claim to receive.'
        : 'They receive only after that number links Flizy.';

    await reply(
      ctx,
      [
        'Claim held.',
        `${plan.input.amount} ${plan.input.asset} reserved for ${plan.input.recipient}`,
        '',
        howReceive,
        `Cancel anytime: ${cmd(ctx, 'cancel claims')}`,
        '',
        'Share claim link:',
        result.claimUrl,
      ]
        .filter(Boolean)
        .join('\n')
    );
    return;
  }

  if (plan.intent === 'SWAP') {
    await reply(ctx, 'Submitting swap...');
    const result = await executeSwapPlan({ plan, provider, chain });
    if (!result.ok) {
      await reply(ctx, result.error || 'Swap failed.');
      return;
    }
    await reply(ctx, 'Swap submitted. Waiting for confirmation...');
    await reply(ctx, formatSwapReceipt(result, plan));
    return;
  }

  // Take the request row before any money moves. Two channels can both hold a
  // confirmed plan for the same request; without this both would pay it and the
  // payer would be debited twice for one request.
  let heldRequest = null;
  if (paymentRequestId) {
    try {
      heldRequest = await beginRequestProcessing(paymentRequestId);
    } catch (err) {
      console.error('beginRequestProcessing:', publicErrorMessage(err));
      await reply(ctx, 'Could not check that request. Try again shortly.');
      return;
    }
    if (!heldRequest) {
      await reply(ctx, 'That request is already being paid, or is no longer open.');
      return;
    }
  }

  await reply(ctx, 'Executing transfer...');

  const result = await executeNativeSend({
    plan,
    provider,
    chain,
    user: fresh,
    supabase,
  });

  if (paymentRequestId) {
    try {
      if (result.ok) {
        await markRequestPaid(paymentRequestId, plan.actor.accountId, result.txHash || null);
        // Requester hears on every linked channel (WA + TG). Payer already has
        // the receipt in this chat; skip that identity so we do not double-ping them.
        const requesterId = heldRequest?.requester_account_id;
        if (requesterId) {
          try {
            const fromLabel = await senderLabel(ctx, plan.actor.accountId, null);
            await notifyAccount(
              requesterId,
              formatRequestPaidNotice({
                amountEth: heldRequest.amount_eth || plan.input.amount,
                fromLabel,
                explorerUrl: result.explorerUrl || null,
              }),
              { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
            );
          } catch (err) {
            console.warn('request paid notify:', publicErrorMessage(err));
          }
        }
      } else if (!result.submitted) {
        // Nothing reached the chain, so the request is open again. Only safe
        // because executeNativeSend tells us it never submitted.
        await releaseRequestProcessing(paymentRequestId);
      } else {
        console.error(
          `[request] ${paymentRequestId} left in processing after a submitted transfer. Check the chain before reopening it.`
        );
      }
    } catch (err) {
      console.warn('payment request settle:', publicErrorMessage(err));
    }
  }

  await reply(ctx, formatSendReceipt(result, plan));
}

/**
 * How to name a person on money notifications.
 *
 * Prefer Flizy @username, then display name, then phone. Never email.
 * Username is recognition only — never a payment routing key.
 *
 * @param {object} ctx
 * @param {string|null} accountId
 * @param {object|null} [identity]
 * @param {{ preferPhone?: boolean }} [opts] preferPhone restores old order for
 *   recipient-facing "from" lines where a number is more familiar
 * @returns {Promise<string>}
 */
async function senderLabel(ctx, accountId, identity, opts = {}) {
  const preferPhone = Boolean(opts.preferPhone);
  const phoneLabel = async () => {
    try {
      const mine = identity || (await resolveClaimIdentity(ctx));
      if (mine.waPhone) return `+${mine.waPhone}`;
    } catch (err) {
      console.warn('senderLabel identity:', publicErrorMessage(err));
    }
    return null;
  };

  const accountLabels = async () => {
    if (!accountId) return { username: null, displayName: null };
    try {
      const { data } = await supabase
        .from('accounts')
        .select('username, display_name')
        .eq('id', accountId)
        .maybeSingle();
      return {
        username: formatUsernameLabel(data?.username),
        displayName: data?.display_name ? String(data.display_name).trim() || null : null,
      };
    } catch (err) {
      console.warn('senderLabel account:', publicErrorMessage(err));
      return { username: null, displayName: null };
    }
  };

  const { username, displayName } = await accountLabels();

  if (preferPhone) {
    return (await phoneLabel()) || username || displayName || 'another Flizy user';
  }
  // Claimed-by and similar: @username first, then display name, then phone
  return username || displayName || (await phoneLabel()) || 'another Flizy user';
}

/**
 * A claim addressed to a number that is already a Flizy user: tell them on every
 * channel they have linked. Unknown numbers are never cold-messaged; the sender
 * shares the claim link instead.
 *
 * The copy uses the "flizy" prefix rather than this sender's channel style,
 * because the recipient may well be reading it somewhere else. That prefix is
 * accepted on every channel.
 *
 * @returns {Promise<boolean>} true when the notice actually went somewhere
 */
async function notifyClaimTarget(ctx, toWaHint, amountEth, fromAccountId, identity) {
  try {
    const from = await senderLabel(ctx, fromAccountId, identity);
    const res = await notifyPhone(
      toWaHint,
      [
        'Pending claim on Flizy',
        '',
        `Amount: ${amountEth} ETH`,
        `From:   ${from}`,
        '',
        'Receive it: flizy claim',
        'It stays held until you do. The sender can cancel until then.',
      ].join('\n'),
      { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
    );
    return Boolean(res.known) && res.delivered + res.queued > 0;
  } catch (err) {
    console.warn('notifyClaimTarget:', publicErrorMessage(err));
    return false;
  }
}

/**
 * Claim addressed to a platform identity already linked on Flizy.
 * @returns {Promise<boolean>}
 */
async function notifyClaimPlatformTarget(
  ctx,
  channel,
  externalId,
  amountEth,
  fromAccountId,
  identity
) {
  try {
    const bound = await getAccountByIdentity(channel, externalId);
    if (!bound?.account?.id) return false;
    const from = await senderLabel(ctx, fromAccountId, identity);
    const res = await notifyAccount(
      bound.account.id,
      [
        'Pending claim on Flizy',
        '',
        `Amount: ${amountEth} ETH`,
        `From:   ${from}`,
        '',
        'Receive it: flizy claim',
        'It stays held until you do. The sender can cancel until then.',
      ].join('\n'),
      { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
    );
    return res.delivered + res.queued > 0;
  } catch (err) {
    console.warn('notifyClaimPlatformTarget:', publicErrorMessage(err));
    return false;
  }
}

async function handleCancel(ctx) {
  if (pendingClaimMenus.has(ctx.key)) {
    pendingClaimMenus.delete(ctx.key);
    await reply(ctx, 'Menu closed.');
    return true;
  }
  if (pendingSends.has(ctx.key)) {
    pendingSends.delete(ctx.key);
    await reply(ctx, 'Plan cancelled. Nothing was executed.');
    return true;
  }
  return false;
}

async function handleSwapCommand(ctx, user, account, parsed) {
  if (parsed.kind === 'price') {
    try {
      const sym = String(parsed.symbol || 'FLZ').toUpperCase();
      if (sym !== 'FLZ' && sym !== 'FLIZY') {
        await reply(ctx, `Price supported for FLZ.\nExample: ${cmd(ctx, 'price FLZ')}`);
        return;
      }
      const px = await getFlzPrice(provider, chain.id);
      await reply(
        ctx,
        [
          'FLZ price',
          `1 ETH ≈ ${formatEth(px.flzPerEth)} FLZ`,
          `1 FLZ ≈ ${formatEth(px.ethPerFlz)} ETH`,
        ].join('\n')
      );
    } catch (err) {
      console.error('price:', publicErrorMessage(err));
      await reply(ctx, 'Could not read price. Try again shortly.');
    }
    return;
  }

  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const dex = getDexConfig(chain.id);
  if (!dex.feeRouter || !dex.flz) {
    await reply(ctx, 'Swap not configured on this chain yet.');
    return;
  }

  let tokenInLabel;
  let tokenOutLabel;
  let tokenIn;
  let tokenOut;
  const amountStr = parsed.amount;

  try {
    if (parsed.kind === 'buy') {
      tokenInLabel = 'ETH';
      tokenOutLabel = tokenLabel(parsed.tokenOut, chain.id);
      tokenIn = null;
      tokenOut = resolveToken(parsed.tokenOut, chain.id);
      if (tokenOut === null) {
        await reply(ctx, 'Buy target must be a token (e.g. FLZ), not ETH.');
        return;
      }
    } else if (parsed.kind === 'sell') {
      tokenInLabel = tokenLabel(parsed.tokenIn, chain.id);
      tokenOutLabel = 'ETH';
      tokenIn = resolveToken(parsed.tokenIn, chain.id);
      tokenOut = null;
      if (tokenIn === null) {
        await reply(ctx, 'Sell input must be a token (e.g. FLZ), not ETH.');
        return;
      }
    } else {
      tokenInLabel = tokenLabel(parsed.tokenIn, chain.id);
      tokenOutLabel = tokenLabel(parsed.tokenOut, chain.id);
      const rawIn = String(parsed.tokenIn || '').toUpperCase();
      const rawOut = String(parsed.tokenOut || '').toUpperCase();
      tokenIn = rawIn === 'ETH' || rawIn === 'NATIVE' ? null : resolveToken(parsed.tokenIn, chain.id);
      tokenOut =
        rawOut === 'ETH' || rawOut === 'NATIVE' ? null : resolveToken(parsed.tokenOut, chain.id);
    }
  } catch (err) {
    await reply(ctx, err.message || 'Unknown token.');
    return;
  }

  let amountInWei;
  try {
    amountInWei = ethers.parseEther(String(amountStr));
    if (amountInWei <= 0n) throw new Error('bad');
  } catch {
    await reply(ctx, `Invalid amount.\nExample: ${cmd(ctx, 'buy 0.01 FLZ')}`);
    return;
  }

  const actor = await actorSessionFlags(ctx, user, siteAcc);
  const intent = createSwapIntent({
    actor,
    side: parsed.kind,
    amountIn: amountStr,
    tokenInLabel,
    tokenOutLabel,
    tokenIn,
    tokenOut,
    routerAddress: dex.feeRouter,
    chainId: chain.id,
    slippageBps: config.swapSlippageBps,
  });

  const policy = await evaluateSwapPolicy(intent);
  if (policy.decision === 'DENY') {
    await reply(ctx, policy.message || 'Swap not allowed.');
    return;
  }

  let quote;
  try {
    quote = await quoteSwap({
      provider,
      amountIn: amountInWei,
      tokenIn,
      tokenOut,
      chainKey: chain.id,
      slippageBps: config.swapSlippageBps,
    });
  } catch (err) {
    console.error('quoteSwap:', publicErrorMessage(err));
    await reply(
      ctx,
      `Could not quote swap (pool or amount issue). Try a smaller amount or ${cmd(ctx, 'price FLZ')}.`
    );
    return;
  }

  const feePct = `${(quote.feeBps / 100).toFixed(2)}%`;
  const slipPct = `${(quote.slippageBps / 100).toFixed(2)}%`;
  const plan = buildSwapPlan({
    intent,
    policy,
    chain: { chainId: chain.chainId, chainName: chain.name, nativeSymbol: chain.nativeSymbol },
    fromAddress: siteAcc.agent_wallet_address,
    amountInDisplay: formatEth(ethers.formatEther(amountInWei)),
    amountOutDisplay: formatEth(ethers.formatEther(quote.amountOut)),
    feeDisplay: formatEth(ethers.formatEther(quote.feeAmount)),
    feePctDisplay: feePct,
    slippagePctDisplay: slipPct,
    tokenInLabel,
    tokenOutLabel,
    routerAddress: dex.feeRouter,
    amountInWei: amountInWei.toString(),
    amountOutMinWei: quote.amountOutMin.toString(),
    inIsNative: quote.inIsNative,
    outIsNative: quote.outIsNative,
    tokenIn,
    tokenOut,
  });

  pendingSends.set(ctx.key, { plan, createdAt: Date.now() });
  await reply(ctx, formatSwapPlanPreview(plan), { buttons: confirmButtons() });
}

async function handleCancelClaims(ctx, user, account, filter) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  const phoneFilter =
    filter && filter !== 'all' && isPlausiblePhone(filter) ? normalizeWaHint(filter) : null;

  let claims;
  try {
    claims = await listOutgoingPending(siteAcc.id, phoneFilter || undefined);
  } catch (err) {
    console.error('listOutgoingPending:', publicErrorMessage(err));
    await reply(ctx, 'Could not load claims. Try again.');
    return;
  }

  if (!claims.length) {
    await reply(
      ctx,
      phoneFilter
        ? `No pending claims to +${phoneFilter}.`
        : `No pending claims.\nSend to a phone: ${cmd(ctx, 'send 0.001 to 2348012345678')}`
    );
    return;
  }

  if (claims.length === 1) {
    pendingClaimMenus.set(ctx.key, {
      mode: 'cancel',
      claims,
      createdAt: Date.now(),
      awaitConfirmId: claims[0].id,
    });
    await reply(
      ctx,
      [
        'Cancel this claim?',
        `${claimRecipientLabel(claims[0])}  ${claims[0].amount_eth} ETH`,
        '',
        'Reply: confirm',
        'Or: cancel',
      ].join('\n'),
      { buttons: confirmButtons() }
    );
    return;
  }

  pendingClaimMenus.set(ctx.key, { mode: 'cancel', claims, createdAt: Date.now() });
  await reply(ctx, formatClaimsMenu(claims, 'outgoing'));
}

async function handleClaimsList(ctx, user, account, kind) {
  if (kind === 'outgoing') {
    return handleCancelClaims(ctx, user, account, null);
  }

  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(
      ctx,
      [
        `Link ${channelName(ctx)} to your Flizy account to see claims for your number.`,
        `Open ${config.siteUrl}/dashboard → generate code → ${cmd(ctx, 'link CODE')}`,
      ].join('\n')
    );
    return;
  }

  let claims;
  let identity;
  try {
    identity = await resolveClaimIdentity(ctx);
    claims = await listIncomingPending(identity);
  } catch (err) {
    console.error('listIncomingPending:', publicErrorMessage(err));
    await reply(ctx, 'Could not load claims. Try again.');
    return;
  }

  if (!claims.length && !identity.waPhone) {
    await reply(
      ctx,
      isTelegram(ctx)
        ? [
            'No claims found yet.',
            '',
            'Claims are addressed by phone number, and Telegram has not shared yours.',
            'Send /phone and tap the button to share it (Telegram verifies the number).',
          ].join('\n')
        : [
            'No pending claims for this WhatsApp.',
            '',
            'Could not read your phone number from WhatsApp (LID-only session).',
            'Claims are addressed by phone. Re-link after updating the bot, or ask the sender to confirm the number.',
          ].join('\n')
    );
    return;
  }

  if (!claims.length) {
    await reply(ctx, 'No pending claims for your number.');
    return;
  }

  if (claims.length === 1) {
    pendingClaimMenus.set(ctx.key, {
      mode: 'claim',
      claims,
      createdAt: Date.now(),
      awaitConfirmId: claims[0].id,
    });
    await reply(
      ctx,
      ['Receive this claim?', `${claims[0].amount_eth} ETH`, '', 'Reply: confirm', 'Or: cancel'].join(
        '\n'
      ),
      { buttons: confirmButtons() }
    );
    return;
  }

  pendingClaimMenus.set(ctx.key, { mode: 'claim', claims, createdAt: Date.now() });
  await reply(ctx, formatClaimsMenu(claims, 'incoming'));
}

/**
 * Menu reply: 1 | 2 | All | confirm (for single item menus)
 * modes: cancel | claim | pay_request | cancel_request
 */
async function handleClaimMenuReply(ctx, user, account, text) {
  const menu = pendingClaimMenus.get(ctx.key);
  if (!menu) return false;

  const t = String(text || '').trim().toLowerCase();
  if (isCancelCommand(t)) {
    pendingClaimMenus.delete(ctx.key);
    await reply(ctx, 'Menu closed.');
    return true;
  }

  const list = menu.requests || menu.claims || [];

  if (menu.awaitConfirmId && isConfirmCommand(t)) {
    pendingClaimMenus.delete(ctx.key);
    if (menu.mode === 'cancel') {
      await runCancelOneClaim(ctx, account, menu.awaitConfirmId);
    } else if (menu.mode === 'claim') {
      await runPayoutOneClaim(ctx, user, account, menu.awaitConfirmId);
    } else if (menu.mode === 'pay_request') {
      await startPayRequest(ctx, user, account, menu.awaitConfirmId);
    } else if (menu.mode === 'cancel_request') {
      await runCancelOneRequest(ctx, account, menu.awaitConfirmId);
    }
    return true;
  }

  let selected = [];
  if (t === 'all') {
    selected = list.slice();
  } else if (/^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    if (idx < 0 || idx >= list.length) {
      await reply(ctx, `Pick 1–${list.length}, All, or cancel.`);
      return true;
    }
    selected = [list[idx]];
  } else {
    return false;
  }

  pendingClaimMenus.delete(ctx.key);

  if (menu.mode === 'cancel') {
    for (const c of selected) await runCancelOneClaim(ctx, account, c.id);
  } else if (menu.mode === 'claim') {
    for (const c of selected) await runPayoutOneClaim(ctx, user, account, c.id);
  } else if (menu.mode === 'pay_request') {
    if (selected.length > 1) {
      await reply(
        ctx,
        'Pay one request at a time. Reply with a single number, then confirm the plan.'
      );
      pendingClaimMenus.set(ctx.key, { ...menu, createdAt: Date.now() });
      return true;
    }
    await startPayRequest(ctx, user, account, selected[0].id);
  } else if (menu.mode === 'cancel_request') {
    for (const r of selected) await runCancelOneRequest(ctx, account, r.id);
  }
  return true;
}

async function runCancelOneClaim(ctx, account, claimId) {
  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(ctx, 'Link your site account first.');
    return;
  }
  await reply(ctx, 'Refunding claim...');
  const result = await executeClaimRefund({
    claimId,
    fromAccountId: siteAcc.id,
    provider,
    chain,
    escrowWallet,
  });
  if (!result.ok) {
    await reply(ctx, result.error || 'Cancel failed.');
    return;
  }
  await reply(
    ctx,
    [
      'Claim cancelled. Funds returned to your agent wallet.',
      result.claim
        ? `Was for ${claimRecipientLabel(result.claim)} (${result.claim.amount_eth} ETH)`
        : null,
      result.explorerUrl || null,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function runPayoutOneClaim(ctx, user, account, claimId) {
  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(
      ctx,
      `Link ${channelName(ctx)} to your Flizy account first to receive claims.\n${cmd(ctx, 'link CODE')}`
    );
    return;
  }
  await reply(ctx, 'Claiming funds...');
  const identity = await resolveClaimIdentity(ctx);
  const result = await executeClaimPayout({
    claimId,
    toAccountId: siteAcc.id,
    toWaSender: identity.waSenderId,
    toWaPhone: identity.waPhone,
    provider,
    chain,
    escrowWallet,
  });
  if (!result.ok) {
    await reply(ctx, result.error || 'Claim failed.');
    return;
  }
  await reply(
    ctx,
    [
      'Claim received.',
      `${result.claim.amount_eth} ETH → your agent wallet`,
      result.explorerUrl || null,
      '',
      `Check: ${cmd(ctx, 'balance')}`,
    ]
      .filter(Boolean)
      .join('\n')
  );

  // Original sender hears on every linked channel (WA + TG), same idea as
  // request paid-notify. Claimer already has the receipt in this chat.
  // Copy always pairs who claimed with the original address path (e.g. GitHub
  // @rudazy) so the sender is not confused about which hold was paid out.
  const senderAccountId = result.claim?.from_account_id;
  if (senderAccountId) {
    try {
      const byLabel = await senderLabel(ctx, siteAcc.id, identity);
      await notifyAccount(
        senderAccountId,
        formatClaimClaimedNotice({
          amountEth: result.claim.amount_eth,
          byLabel,
          viaLine: claimViaLine(result.claim),
          explorerUrl: result.explorerUrl || null,
        }),
        { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
      );
    } catch (err) {
      console.warn('claim claimed notify:', publicErrorMessage(err));
    }
  }
}

async function notifyIncomingAfterLink(ctx) {
  try {
    const identity = await resolveClaimIdentity(ctx);
    const claims = await listIncomingPending(identity);
    const requests = await listIncomingRequests(identity);
    const parts = [];
    if (claims.length) {
      const total = claims.reduce((s, c) => s + Number(c.amount_eth || 0), 0);
      parts.push(
        `${claims.length} pending claim(s) (~${formatEth(total)} ETH). Receive: ${cmd(ctx, 'claim')}`
      );
    }
    if (requests.length) {
      parts.push(`${requests.length} payment request(s). Pay: ${cmd(ctx, 'pay')}`);
    }
    if (!parts.length) return;
    await reply(ctx, ['After link, waiting for you:', ...parts.map((p) => `• ${p}`)].join('\n'));
  } catch (err) {
    console.warn('notifyIncomingAfterLink:', publicErrorMessage(err));
  }
}

async function handleRequestMoney(ctx, user, account, amountEth, fromRaw, isPhone) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  let amountNum;
  try {
    amountNum = Number(amountEth);
    ethers.parseEther(String(amountEth));
    if (!(amountNum > 0)) throw new Error('bad');
  } catch {
    await reply(
      ctx,
      `Invalid amount.\nExample: ${cmd(ctx, 'request 0.001 from 2348012345678')}`
    );
    return;
  }
  if (amountNum > config.maxSendEth) {
    await reply(ctx, `Max per request is ${config.maxSendEth} ETH.`);
    return;
  }

  if (!isPhone) {
    await reply(
      ctx,
      [
        'Requests work by phone number so the payer sees them after linking.',
        `Use: ${cmd(ctx, `request ${amountEth} from 234…`)}`,
      ].join('\n')
    );
    return;
  }

  const fromWaHint = normalizeWaHint(fromRaw);
  if (!isPlausiblePhone(fromWaHint)) {
    await reply(ctx, 'Invalid phone. Use country code digits.');
    return;
  }

  const mine = await resolveClaimIdentity(ctx);
  const myNumbers = [mine.waPhone, mine.waSenderId]
    .filter(Boolean)
    .map((n) => normalizeWaHint(n));
  if (myNumbers.includes(fromWaHint)) {
    await reply(ctx, 'You cannot request money from your own number.');
    return;
  }

  try {
    const row = await createPaymentRequest({
      requesterAccountId: siteAcc.id,
      // Rendered to the payer as "+<number>", so only a real phone belongs here
      requesterWa: mine.waPhone || null,
      fromWaHint,
      fromLabel: null,
      amountEth,
      chainId: chain.chainId,
    });

    // Prefix form, not this channel's style: the payer may read it elsewhere
    await notifyPhone(
      fromWaHint,
      [
        'You have a payment request on Flizy.',
        `${amountEth} ETH requested.`,
        '',
        'Review and pay: flizy pay',
      ].join('\n'),
      { skip: [{ channel: ctx.channel, externalId: ctx.externalId }] }
    );

    await reply(
      ctx,
      [
        'Payment request created.',
        `Amount: ${amountEth} ETH`,
        `From: +${fromWaHint}`,
        '',
        'They see it once that number is on Flizy, then:',
        `  ${cmd(ctx, 'pay')}`,
        '',
        `Cancel anytime: ${cmd(ctx, 'requests')}`,
        `Id: ${String(row.id).slice(0, 8)}…`,
      ].join('\n')
    );
  } catch (err) {
    console.error('createPaymentRequest:', publicErrorMessage(err));
    await reply(ctx, 'Could not create request. Try again.');
  }
}

async function handleRequestsCommand(ctx, user, account, kind) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;

  if (kind === 'incoming') {
    let rows;
    try {
      const identity = await resolveClaimIdentity(ctx);
      rows = await listIncomingRequests(identity);
    } catch (err) {
      console.error(publicErrorMessage(err));
      await reply(ctx, 'Could not load requests.');
      return;
    }
    if (!rows.length) {
      await reply(ctx, formatRequestsMenu([], 'incoming'));
      return;
    }
    if (rows.length === 1) {
      pendingClaimMenus.set(ctx.key, {
        mode: 'pay_request',
        requests: rows,
        createdAt: Date.now(),
        awaitConfirmId: rows[0].id,
      });
      await reply(
        ctx,
        ['Pay this request?', `${rows[0].amount_eth} ETH`, '', 'Reply: confirm', 'Or: cancel'].join(
          '\n'
        ),
        { buttons: confirmButtons() }
      );
      return;
    }
    pendingClaimMenus.set(ctx.key, { mode: 'pay_request', requests: rows, createdAt: Date.now() });
    await reply(ctx, formatRequestsMenu(rows, 'incoming'));
    return;
  }

  let rows;
  try {
    rows = await listOutgoingRequests(siteAcc.id);
  } catch (err) {
    console.error(publicErrorMessage(err));
    await reply(ctx, 'Could not load requests.');
    return;
  }
  if (!rows.length) {
    await reply(ctx, formatRequestsMenu([], 'outgoing'));
    return;
  }
  if (rows.length === 1) {
    pendingClaimMenus.set(ctx.key, {
      mode: 'cancel_request',
      requests: rows,
      createdAt: Date.now(),
      awaitConfirmId: rows[0].id,
    });
    await reply(
      ctx,
      [
        'Cancel this request?',
        `${rows[0].amount_eth} ETH from +${rows[0].from_wa_hint || '?'}`,
        '',
        'Reply: confirm',
        'Or: cancel',
      ].join('\n'),
      { buttons: confirmButtons() }
    );
    return;
  }
  pendingClaimMenus.set(ctx.key, { mode: 'cancel_request', requests: rows, createdAt: Date.now() });
  await reply(ctx, formatRequestsMenu(rows, 'outgoing'));
}

/**
 * How to name the person asking for money on the confirm screen.
 *
 * This preview used to read "To: request (0x1234…abcd)", which named nobody:
 * anyone who knows a phone number can raise a request, and the one screen
 * standing between that and the money never said who was asking.
 *
 * Display name first here, unlike senderLabel() which prefers the phone. A
 * received-money notice goes to somebody deciding whether they recognise a
 * number; this is a payer deciding whether they know a person, and the name is
 * what carries that. The name belongs to the requester, not the payer, so it is
 * sanitized: see displaySafeLabel.
 *
 * @param {object} req payment_requests row
 * @returns {Promise<string>} never empty, never the literal "request"
 */
async function requesterLabel(req) {
  const accountId = req?.requester_account_id || null;
  if (accountId) {
    try {
      const { data } = await supabase
        .from('accounts')
        .select('display_name')
        .eq('id', accountId)
        .maybeSingle();
      const name = displaySafeLabel(data?.display_name);
      if (name) return name;
    } catch (err) {
      console.warn('requesterLabel account:', publicErrorMessage(err));
    }
  }
  const phone = normalizeWaHint(req?.requester_wa || '');
  if (isPlausiblePhone(phone)) return `+${phone}`;
  // Honest, and still not a name the requester chose
  return 'unknown requester';
}

async function startPayRequest(ctx, user, account, requestId) {
  const siteAcc = await requireLinkedSite(ctx, account);
  if (!siteAcc) return;
  const req = await getPaymentRequestById(requestId);
  if (!req || req.status !== 'pending') {
    await reply(ctx, 'That request is no longer pending.');
    return;
  }
  const identity = await resolveClaimIdentity(ctx);
  // Account-wide phones (Telegram may hold the request while the number lives
  // on the WhatsApp identity of the same account).
  const keys = claimMatchKeysForAccount(identity);
  const reqHint = normalizeWaHint(req.from_wa_hint);
  if (!keys.length || !keys.includes(reqHint)) {
    await reply(
      ctx,
      keys.length
        ? 'This request is for a different phone number.'
        : 'Could not verify your phone for this request. On Telegram use /phone, then try again.'
    );
    return;
  }
  const requesterAcc = await ensureAgentWallet(req.requester_account_id);
  const toAddress = requesterAcc.agent_wallet_address;
  if (!toAddress) {
    await reply(ctx, 'Requester has no agent wallet yet.');
    return;
  }
  // skipTrusted stays. The allowlist exists so a compromised bot cannot pick its
  // own destination; it is not there to stop a user paying a named human who
  // asked them. Requiring the requester to be pre-trusted would make the feature
  // useless, since the point is being asked by somebody you have not paid yet.
  // What was missing is honesty on the screen, which requesterLabel and the
  // "not on your trusted list" line in formatPlanPreview now provide.
  await handleSendResolved(
    ctx,
    user,
    String(req.amount_eth),
    { address: ethers.getAddress(toAddress), label: await requesterLabel(req) },
    siteAcc,
    { skipTrusted: true, paymentRequestId: req.id }
  );
}

async function runCancelOneRequest(ctx, account, requestId) {
  const siteAcc = await resolveLinkedSiteAccount(ctx, account);
  if (!siteAcc?.id) {
    await reply(ctx, 'Link your site account first.');
    return;
  }
  const result = await cancelPaymentRequest(requestId, siteAcc.id);
  if (!result.ok) {
    await reply(ctx, 'Could not cancel (already paid or not yours).');
    return;
  }
  await reply(ctx, 'Request cancelled.');
}

/**
 * Bind this chat identity to the account that generated the code.
 * The code is the identity proof: only a logged-in account holder can make one.
 */
async function handleLink(ctx, code) {
  try {
    let verifiedPhone = null;
    if (typeof ctx.resolveVerifiedPhone === 'function') {
      try {
        verifiedPhone = await ctx.resolveVerifiedPhone();
      } catch (err) {
        console.warn('resolveVerifiedPhone:', publicErrorMessage(err));
      }
    }

    // The code itself is a credential that binds a chat app to an account, so it
    // is masked here for the same reason an unlock secret is never logged.
    console.log(
      `[link] attempt channel=${ctx.channel} id=${maskPhone(ctx.externalId)} phone=${
        verifiedPhone ? maskPhone(verifiedPhone) : 'none'
      } code=${maskLinkCode(code)}`
    );

    const result = await consumeLinkCode(ctx.channel, ctx.externalId, code, verifiedPhone);

    if (!result.ok) {
      if (result.reason === 'locked_out') {
        await reply(
          ctx,
          [
            'Too many wrong link codes from this chat.',
            `Try again in about ${result.retryAfterText || 'a while'}.`,
            '',
            'A code is only valid for 10 minutes. Open the Flizy site and',
            'generate a fresh one rather than retyping an old one.',
          ].join('\n')
        );
        return;
      }
      if (result.reason === 'used') {
        // The common case by far: one code, two buttons on the dashboard. Say
        // which chat app spent it, because "invalid" sent people hunting for a
        // typo that was never there.
        const spentOn =
          result.usedByChannel === 'whatsapp'
            ? 'WhatsApp'
            : result.usedByChannel === 'telegram'
              ? 'Telegram'
              : 'another chat';
        await reply(
          ctx,
          [
            `That code was already used to link ${spentOn}.`,
            '',
            'Each code works once. Open the Flizy site, generate a new one,',
            `and use it here first: ${cmd(ctx, 'link CODE')}`,
          ].join('\n')
        );
        return;
      }
      if (result.reason === 'expired') {
        await reply(ctx, 'That link code expired. Generate a new one on the Flizy site.');
        return;
      }
      if (result.reason === 'phone_bound_elsewhere') {
        await reply(
          ctx,
          [
            'Not linked.',
            'This phone number is already on a different Flizy account.',
            '',
            'One number belongs to one account. Log in to that account on the site,',
            'or remove the number there first, then link again.',
          ].join('\n')
        );
        return;
      }
      const tail =
        result.lockedForMs > 0
          ? `\nToo many wrong codes. Wait about ${result.retryAfterText} before trying again.`
          : result.attemptsLeft != null && result.attemptsLeft <= 2
            ? `\nTries left before a timeout: ${result.attemptsLeft}`
            : '';
      await reply(
        ctx,
        `Invalid link code. Open the Flizy site and generate a fresh link.${tail}`
      );
      return;
    }

    const acc = await ensureAgentWallet(result.account.id);
    const { user } = await resolveLegacyUser(ctx, acc.id);

    // Keep the legacy ledger row aligned with the site account
    await supabase
      .from('users')
      .update({
        account_id: acc.id,
        balance_eth: acc.balance_eth ?? 0,
        is_admin: Boolean(acc.is_admin),
        wallet_address: acc.agent_wallet_address,
      })
      .eq('id', user.id);

    console.log(
      `[link] ok channel=${ctx.channel} id=${maskPhone(ctx.externalId)} account=${acc.id}`
    );

    await reply(
      ctx,
      [
        `${channelName(ctx)} connected to Flizy.`,
        '',
        'Your Flizy account',
        acc.email ? `Email: ${acc.email}` : null,
        acc.display_name ? `Name: ${acc.display_name}` : null,
        `Agent wallet: ${acc.agent_wallet_address || 'pending'}`,
        `${channelName(ctx)} id: ${ctx.externalId}`,
        '',
        'Commands',
        `  ${cmd(ctx, 'me')}`,
        `  ${cmd(ctx, 'balance')}`,
        `  ${cmd(ctx, 'add wallet 0x...')}`,
        `  ${cmd(ctx, 'send 0.0001 to john')}`,
        '  confirm',
        '',
        `Reply with ${cmd(ctx, 'me')} to confirm.`,
      ]
        .filter(Boolean)
        .join('\n')
    );

    // Claims are addressed by phone. Ask for a verified number when we lack one.
    if (!result.phone && typeof ctx.requestPhone === 'function') {
      await ctx.requestPhone(
        [
          'One more step to receive money sent to your phone number.',
          '',
          'Tap the button below to share your number.',
          'Telegram verifies it; a typed number is never accepted.',
          'Skip this and you can still send, swap and pay requests.',
        ].join('\n')
      );
    }

    await notifyIncomingAfterLink(ctx);
  } catch (err) {
    console.error('link error:', publicErrorMessage(err));
    await reply(ctx, 'Could not link right now. Try a new code from the site.');
  }
}

/**
 * A channel-verified phone arrived (Telegram contact share).
 * The only path that writes a claim phone from a chat.
 *
 * @param {object} ctx
 * @param {{ phone: string, verified: boolean }} shared
 */
async function handleSharedPhone(ctx, shared) {
  if (!shared || !shared.verified) {
    await reply(
      ctx,
      'Use the Share number button so your number can be verified. A typed number is not accepted.'
    );
    return;
  }

  const phone = normalizePhoneNumber(shared.phone);
  if (!isPlausiblePhone(phone)) {
    await reply(ctx, 'That number does not look valid. Try the share button again.');
    return;
  }

  const bound = await getAccountByIdentity(ctx.channel, ctx.externalId);
  if (!bound?.account?.id) {
    await reply(
      ctx,
      `Link your Flizy account first, then share your number.\n${cmd(ctx, 'link CODE')}`
    );
    return;
  }

  // Clients call this straight from a contact-share tap, so it never passes
  // through handle() and its lock gate. It is still a step of a flow the bot
  // started, and it decides which number's claims land in this account, so it
  // gets the same gate.
  if (await isSessionHardLocked(bound.account.id, ctx.channel, ctx.externalId)) {
    await reply(
      ctx,
      `Session locked. Nothing was saved.\nSend: ${cmd(ctx, 'unlock')}\nThen share your number again.`
    );
    return;
  }

  const res = await setIdentityPhone(ctx.channel, ctx.externalId, phone);
  if (!res.ok) {
    if (res.reason === 'phone_taken') {
      await reply(
        ctx,
        [
          'Not saved.',
          'This number is already on a different Flizy account.',
          '',
          'One number belongs to one account. Use that account, or remove the number there first.',
        ].join('\n')
      );
      return;
    }
    await reply(ctx, 'Could not save that number. Try again.');
    return;
  }

  await reply(
    ctx,
    [
      'Number verified.',
      `Claims and requests sent to +${res.phone} now reach you here.`,
      '',
      `Check now: ${cmd(ctx, 'claim')}`,
    ].join('\n')
  );

  await notifyIncomingAfterLink(ctx);
}

async function handleSaveContact(ctx, user, alias, address) {
  try {
    const saved = await saveContact(user, ctx.externalId, alias, address);
    await reply(
      ctx,
      [
        'Contact saved.',
        `  ${saved.alias} → ${saved.address}`,
        '',
        `Now you can: ${cmd(ctx, `send 0.001 to ${saved.alias}`)}`,
        `List all: ${cmd(ctx, 'contacts')}`,
      ].join('\n')
    );
  } catch (err) {
    await reply(ctx, `Could not save contact: ${err.message}`);
  }
}

async function handleRemoveContact(ctx, account, alias) {
  try {
    const owners = await ownerKeysForAccount(ctx, account?.id || null);
    const removed = await removeContact(owners, alias);
    if (!removed) {
      await reply(ctx, `No contact named "${alias}". Send ${cmd(ctx, 'contacts')} to list.`);
      return;
    }
    await reply(ctx, `Removed contact "${alias}".`);
  } catch (err) {
    await reply(ctx, `Could not remove contact: ${err.message}`);
  }
}

async function handleContactsList(ctx, account) {
  try {
    const owners = await ownerKeysForAccount(ctx, account?.id || null);
    const rows = await listContacts(owners);
    if (!rows.length) {
      await reply(
        ctx,
        [
          'No contacts yet.',
          `Save one: ${cmd(ctx, 'save ama 0xYourAddressHere')}`,
          `Then: ${cmd(ctx, 'send 0.001 to ama')}`,
        ].join('\n')
      );
      return;
    }
    const lines = ['Your contacts:'];
    for (const row of rows) {
      lines.push(`  ${row.alias} → ${row.address}`);
    }
    lines.push('', `Send: ${cmd(ctx, `send 0.001 to ${rows[0].alias}`)}`);
    await reply(ctx, lines.join('\n'));
  } catch (err) {
    await reply(ctx, `Could not list contacts: ${err.message}`);
  }
}

async function handlePhoneShare(ctx, account) {
  const bound = await getAccountByIdentity(ctx.channel, ctx.externalId);
  if (!bound?.account?.id) {
    await reply(
      ctx,
      `Link your Flizy account first.\n${cmd(ctx, 'link CODE')}`
    );
    return;
  }
  if (bound.identity?.phone_e164) {
    await reply(
      ctx,
      [
        `Your number is already verified: +${bound.identity.phone_e164}`,
        `Claims to it reach you here. Check: ${cmd(ctx, 'claim')}`,
      ].join('\n')
    );
    return;
  }
  if (typeof ctx.requestPhone !== 'function') {
    await reply(
      ctx,
      'This channel reads your number automatically. Nothing to share.'
    );
    return;
  }
  await ctx.requestPhone(
    [
      'Share your number so money sent to it reaches you here.',
      '',
      'Tap the button below. Telegram verifies the number;',
      'a typed number is never accepted.',
    ].join('\n')
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Handle one inbound chat message.
 * Clients call this after their own channel filters (groups, echoes, spam).
 *
 * @param {object} ctx
 * @param {string} rawText
 */
async function handle(ctx, rawText) {
  try {
    pruneExpiredPending();

    const normalized = normalizeInput(ctx, rawText);
    if (!normalized) {
      if (isTelegram(ctx)) {
        await reply(ctx, `Not a Flizy command. Send ${cmd(ctx, 'help')} for the list.`);
      }
      return;
    }
    const text = normalized.text;

    // Never log the body of an unlock exchange: that message IS the password.
    const verb = text.split(/\s+/)[0].toLowerCase();
    const secretish = pendingUnlocks.has(ctx.key) || verb === 'unlock';
    console.log(
      `[msg] ${ctx.key} ${secretish ? 'cmd=unlock <secret hidden>' : `body=${JSON.stringify(text.slice(0, 120))}`}`
    );

    // Link FIRST, before auto-creating a competing account for this identity.
    // A link also ends any name step that was open, the way it always has.
    const linkCmd = parseLinkCommand(text);
    if (linkCmd) {
      pendingWalletAdds.delete(ctx.key);
      await handleLink(ctx, linkCmd.code);
      return;
    }

    let user;
    let isNew = false;
    let account = null;
    try {
      const bridged = await getOrCreateAccountForIdentity(ctx.channel, ctx.externalId);
      account = bridged.account;
      const resolved = await resolveLegacyUser(ctx, account?.id || null);
      user = resolved.user;
      isNew = resolved.isNew;
    } catch (err) {
      console.error('identity bridge error:', publicErrorMessage(err));
      await reply(ctx, 'Database error registering you. Try again shortly.');
      return;
    }

    // Lock (no password). Above the unlock paths on purpose: while the bot is
    // waiting for a secret, the next message is read as that secret, and "lock"
    // is a safety action that must never be swallowed as a wrong guess.
    if (parseLockCommand(text)) {
      discardPendingFlows(ctx.key);
      if (!account?.id) {
        await reply(
          ctx,
          `Link your site account first, then lock.\nOpen the dashboard and send: ${cmd(ctx, 'link CODE')}`
        );
        return;
      }
      try {
        await lockSession(account.id, ctx.channel, ctx.externalId);
      } catch (lockErr) {
        console.error('lockSession failed:', publicErrorMessage(lockErr));
        await reply(ctx, 'Could not lock session right now. Try again in a moment.');
        return;
      }
      await reply(
        ctx,
        [
          `Session locked on ${channelName(ctx)}.`,
          'Other commands will not run here until you unlock.',
          `Unlock: ${cmd(ctx, 'unlock')}`,
          'Then reply with your password or PIN when asked.',
        ].join('\n')
      );
      return;
    }

    // Interactive unlock reply (plain secret, no prefix)
    if (pendingUnlocks.has(ctx.key)) {
      const wait = pendingUnlocks.get(ctx.key);
      if (Date.now() - wait.createdAt > PENDING_TTL_MS) {
        pendingUnlocks.delete(ctx.key);
        await reply(ctx, `Unlock timed out. Send: ${cmd(ctx, 'unlock')}`);
        return;
      }
      const unlockAgain = parseUnlockCommand(text);
      if (unlockAgain && unlockAgain.pin == null) {
        await reply(
          ctx,
          'Reply with your account password or unlock PIN.\n(Send only the secret as the next message.)'
        );
        return;
      }
      const secret =
        unlockAgain && unlockAgain.pin != null ? unlockAgain.pin : String(text || '').trim();

      if (!account?.id) {
        pendingUnlocks.delete(ctx.key);
        await reply(
          ctx,
          `Link your site account first, then unlock.\nOpen the dashboard and send: ${cmd(ctx, 'link CODE')}`
        );
        return;
      }
      pendingUnlocks.delete(ctx.key);
      const res = await unlockWithPin(account, ctx.channel, ctx.externalId, secret);
      if (!res.ok && (res.reason === 'no_pin' || res.reason === 'no_account')) {
        await reply(
          ctx,
          `No password or PIN on this account.\nSet a PIN on the site: ${config.siteUrl}/dashboard/account`
        );
        return;
      }
      if (!res.ok) {
        await reply(ctx, unlockFailureText(ctx, res));
        return;
      }
      await reply(
        ctx,
        `Session unlocked on ${channelName(ctx)}.\nCommands work again for about 1 hour of activity.\nLock anytime: ${cmd(ctx, 'lock')}`
      );
      return;
    }

    // Unlock: prompt or one-shot secret
    const unlockCmd = parseUnlockCommand(text);
    if (unlockCmd) {
      if (!account?.id) {
        await reply(
          ctx,
          `Link your site account first.\nOpen the dashboard and send: ${cmd(ctx, 'link CODE')}`
        );
        return;
      }
      if (unlockCmd.pin == null || unlockCmd.pin === '') {
        pendingUnlocks.set(ctx.key, { createdAt: Date.now() });
        await reply(
          ctx,
          [
            `Unlock Flizy on this ${channelName(ctx)}.`,
            'Reply with your site login password or unlock PIN.',
            'Send only the secret as the next message.',
          ].join('\n')
        );
        return;
      }
      const res = await unlockWithPin(account, ctx.channel, ctx.externalId, unlockCmd.pin);
      if (!res.ok && (res.reason === 'no_pin' || res.reason === 'no_account')) {
        await reply(
          ctx,
          `No password or PIN on this account.\nSet a PIN on the site: ${config.siteUrl}/dashboard/account`
        );
        return;
      }
      if (!res.ok) {
        await reply(ctx, unlockFailureText(ctx, res));
        return;
      }
      await reply(
        ctx,
        `Session unlocked on ${channelName(ctx)}.\nCommands work again for about 1 hour of activity.\nLock anytime: ${cmd(ctx, 'lock')}`
      );
      return;
    }

    // Hard lock gate: only unlock / link may run while locked
    if (!isAdminUser(user) && account?.id) {
      const hardLocked = await isSessionHardLocked(account.id, ctx.channel, ctx.externalId);
      if (hardLocked && !isAllowedWhenLocked(text)) {
        await reply(
          ctx,
          `Session locked.\nSend: ${cmd(ctx, 'unlock')}\nThen reply with your password or PIN.`
        );
        return;
      }
      try {
        const row = await getSession(account.id, ctx.channel, ctx.externalId);
        if (row && !row.is_locked && new Date(row.expires_at).getTime() > Date.now()) {
          await touchSession(account.id, ctx.channel, ctx.externalId);
        }
      } catch {
        /* ignore */
      }
    }

    // Finish "add wallet" name step (a bare reply like "john" is allowed).
    //
    // Below the hard-lock gate on purpose. This used to sit at the top of the
    // router, so a trusted-wallet-add started before the session locked could
    // still be finished while it was locked, which is a new payout destination
    // added by whoever was holding the phone. Every pending flow now resumes
    // behind the gate, and locking discards them anyway.
    if (pendingWalletAdds.has(ctx.key)) {
      const pendingAdd = pendingWalletAdds.get(ctx.key);
      const nameCandidate = text;

      if (isCancelCommand(nameCandidate)) {
        pendingWalletAdds.delete(ctx.key);
        await reply(ctx, 'Cancelled.');
        return;
      }

      // Never treat our own prompt copy as a label
      const lower = nameCandidate.trim().toLowerCase();
      if (
        lower === 'name' ||
        lower.startsWith('what should we call') ||
        lower.startsWith('added ') ||
        lower.startsWith('reply with one word')
      ) {
        return;
      }

      const looksLikeNewCommand =
        Boolean(parseAddWalletCommand(nameCandidate)) ||
        Boolean(parseSendCommand(nameCandidate)) ||
        Boolean(parseLinkCommand(nameCandidate)) ||
        isHelpCommand(nameCandidate) ||
        isBalanceCommand(nameCandidate) ||
        isMeCommand(nameCandidate) ||
        isHistoryCommand(nameCandidate) ||
        isDepositCommand(nameCandidate) ||
        isConfirmCommand(nameCandidate);

      if (!looksLikeNewCommand) {
        const chosen = nameCandidate.trim();
        if (!isValidTrustedName(chosen)) {
          await reply(
            ctx,
            'Name must start with a letter (a-z), then letters/numbers/_ only.\nExample: john\nOr: cancel'
          );
          return;
        }
        try {
          const bridged = await getOrCreateAccountForIdentity(ctx.channel, ctx.externalId);
          const acc = await ensureAgentWallet(bridged.account.id);
          await resolveLegacyUser(ctx, acc.id);
          await addTrusted(acc.id, pendingAdd.address, chosen.toLowerCase());
          pendingWalletAdds.delete(ctx.key);
          await reply(ctx, `Added ${chosen.toLowerCase()}`);
        } catch (err) {
          console.error('add wallet name step:', publicErrorMessage(err));
          pendingWalletAdds.delete(ctx.key);
          await reply(ctx, 'Could not add wallet. Try again.');
        }
        return;
      }
      pendingWalletAdds.delete(ctx.key);
    }

    // A first-ever message gets the welcome. When that message was itself a
    // request for help, the command list still has to follow it: returning here
    // left a new user staring at a greeting with no commands in it.
    if (isNew) {
      await reply(ctx, welcomeText(ctx, user));
    }

    if (isHelpCommand(text)) {
      await reply(ctx, helpText(ctx));
      return;
    }

    if (isHowCommand(text)) {
      await reply(ctx, howOthersUseText(ctx));
      return;
    }

    if (isMeCommand(text)) {
      await handleMe(ctx, user, account);
      return;
    }

    if (isPhoneShareCommand(text)) {
      await handlePhoneShare(ctx, account);
      return;
    }

    if (isDepositCommand(text)) {
      await handleDeposit(ctx, user, account);
      return;
    }

    if (isBalanceCommand(text)) {
      await handleBalance(ctx, user, account);
      return;
    }

    if (isHistoryCommand(text)) {
      await handleHistory(ctx, account);
      return;
    }

    if (isContactsListCommand(text)) {
      await handleContactsList(ctx, account);
      return;
    }

    if (isPoolCommand(text)) {
      await handlePool(ctx, user);
      return;
    }

    if (isEscrowCommand(text)) {
      await handleEscrow(ctx, user);
      return;
    }

    if (isUsersCommand(text)) {
      await handleUsers(ctx, user);
      return;
    }

    const addWalletCmd = parseAddWalletCommand(text);
    if (addWalletCmd) {
      if (!ethers.isAddress(addWalletCmd.address)) {
        await reply(ctx, 'Invalid address. Use a full 0x wallet address.');
        return;
      }
      const checksum = ethers.getAddress(addWalletCmd.address);
      pendingSends.delete(ctx.key);
      pendingWalletAdds.set(ctx.key, { address: checksum, createdAt: Date.now() });
      await reply(
        ctx,
        [
          'What should we call this wallet?',
          `Address: ${shortAddress(checksum)}`,
          '',
          'Reply with ONE word you choose (example: john)',
          'Or: cancel',
        ].join('\n')
      );
      return;
    }

    const saveCmd = parseSaveContactCommand(text);
    if (saveCmd) {
      await handleSaveContact(ctx, user, saveCmd.alias, saveCmd.address);
      return;
    }

    const removeCmd = parseRemoveContactCommand(text);
    if (removeCmd) {
      await handleRemoveContact(ctx, account, removeCmd.alias);
      return;
    }

    const claimAdmin = parseClaimAdminCommand(text);
    if (claimAdmin) {
      await handleClaimAdmin(ctx, user, claimAdmin.secret);
      return;
    }

    const creditCmd = parseCreditCommand(text);
    if (creditCmd) {
      await handleCredit(ctx, user, creditCmd.phone, creditCmd.amountEth);
      return;
    }

    // Claim / request menus (1, 2, All, confirm)
    if (pendingClaimMenus.has(ctx.key)) {
      const handledMenu = await handleClaimMenuReply(ctx, user, account, text);
      if (handledMenu) return;
    }

    const cancelClaims = parseCancelClaimsCommand(text);
    if (cancelClaims) {
      await handleCancelClaims(ctx, user, account, cancelClaims.filter);
      return;
    }

    const claimsList = parseClaimsListCommand(text);
    if (claimsList) {
      await handleClaimsList(ctx, user, account, claimsList.kind);
      return;
    }

    const reqCmd = parseRequestCommand(text);
    if (reqCmd) {
      await handleRequestMoney(ctx, user, account, reqCmd.amountEth, reqCmd.fromRaw, reqCmd.isPhone);
      return;
    }

    const requestsCmd = parseRequestsCommand(text);
    if (requestsCmd) {
      await handleRequestsCommand(ctx, user, account, requestsCmd.kind);
      return;
    }

    if (isCancelCommand(text)) {
      await handleCancel(ctx);
      return;
    }

    if (isConfirmCommand(text)) {
      if (pendingClaimMenus.has(ctx.key)) {
        await handleClaimMenuReply(ctx, user, account, text);
        return;
      }
      await handleConfirm(ctx, user, account);
      return;
    }

    const swapCmd = parseSwapCommand(text);
    if (swapCmd) {
      await handleSwapCommand(ctx, user, account, swapCmd);
      return;
    }

    const send = parseSendCommand(text);
    if (send) {
      await handleSend(
        ctx,
        user,
        account,
        send.amountEth,
        send.toRaw,
        send.isAddress,
        send.isPhone,
        send.asset || 'ETH',
        send.platform || null
      );
      return;
    }

    if (isTelegram(ctx)) {
      await reply(ctx, `Unknown command. Send ${cmd(ctx, 'help')} for the list.`);
    }
  } catch (err) {
    console.error('router error:', publicErrorMessage(err));
    await reply(ctx, 'Something went wrong. Please try again.');
  }
}

module.exports = {
  handle,
  handleSharedPhone,
  pendingFlowFor,
  discardPendingFlows,
  pruneExpiredPending,
  isFlizyCommand,
  isFlizyCommandBody,
  isConfirmCommand,
  isCancelCommand,
  normalizeInput,
  commandMenu,
  helpText,
  welcomeText,
  // exported for tests
  parseSendCommand,
  parseSwapCommand,
  parseLinkCommand,
  parseRequestCommand,
  resolveClaimIdentity,
  resolveSendTarget,
  requesterLabel,
  transferKey,
  cmd,
};
