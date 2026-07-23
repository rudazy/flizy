const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { ethers } = require('ethers');
require('dotenv').config();

const { config, requireEnv } = require('./lib/config');
const { getDefaultChain, explorerTxUrl: chainTxUrl, explorerAddressUrl: chainAddressUrl } = require('./lib/chains');
const { getSupabase } = require('./lib/supabase');
const { publicErrorMessage } = require('./lib/sanitize');
const {
  getOrCreateAccountForSender,
  getAccountByWaSender,
  consumeLinkCode,
  setIdentityPhone,
} = require('./lib/identity');
const {
  normalizePhoneNumber,
  isPlausiblePhone,
  claimMatchKeys,
  maskPhone,
} = require('./lib/phone');
const { stripFlizyPrefix, parseUnlockCommand, parseLockCommand } = require('./lib/prefix');
const {
  isSessionUnlocked,
  isSessionHardLocked,
  unlockWithPin,
  touchSession,
  lockSession,
} = require('./lib/session');
const { addTrusted } = require('./lib/trusted');
const {
  normalizeWaHint,
  listOutgoingPending,
  listIncomingPending,
  formatClaimsMenu,
} = require('./lib/claims');
const {
  ensureAgentWallet,
  formatAccountWalletCard,
} = require('./lib/agentWallet');
const { getEscrowWallet, formatEscrowStatus } = require('./lib/escrowWallet');
const { getWalletHoldings, formatHoldingsMessage } = require('./lib/holdings');
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
} = require('./lib/engine');
const {
  createPaymentRequest,
  listOutgoingRequests,
  listIncomingRequests,
  cancelPaymentRequest,
  markRequestPaid,
  getPaymentRequestById,
  formatRequestsMenu,
} = require('./lib/paymentRequests');
const {
  getDexConfig,
  resolveToken,
  tokenLabel,
  quoteSwap,
  getFlzPrice,
} = require('./lib/dex');

// ---------------------------------------------------------------------------
// Config (Phase 0: chain registry + config-driven copy)
// ---------------------------------------------------------------------------

requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'GIWA_RPC', 'PRIVATE_KEY']);

const chain = getDefaultChain();
const PENDING_TTL_MS = config.pendingTtlMs;
const ADMIN_PHONES = config.adminPhones;

const supabase = getSupabase();
const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
/** Ops: gas / infra only — never hold user claim escrow */
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
/** Claim escrow: separate address (ESCROW_PRIVATE_KEY or derived) */
const escrowWallet = getEscrowWallet(provider);

/**
 * Pending confirmed sends: full Execution Plan (Intent → Policy → Plan).
 * @type {Map<string, { plan: object, createdAt: number }>}
 */
const pendingSends = new Map();

/** @type {Map<string, { address: string, createdAt: number }>} */
const pendingWalletAdds = new Map();

/**
 * Interactive menus: claims + payment requests.
 * @type {Map<string, { mode: string, claims?: object[], requests?: object[], createdAt: number, awaitConfirmId?: string }>}
 */
const pendingClaimMenus = new Map();

/**
 * Waiting for unlock password after `flizy unlock` (no secret on same line).
 * @type {Map<string, { createdAt: number }>}
 */
const pendingUnlocks = new Map();

/**
 * Last bot outbound body per chat (Message yourself treats bot replies as fromMe).
 * Used to ignore our own echoes so "name" prompt is not saved as the label.
 * @type {Map<string, { body: string, at: number }>}
 */
const lastBotOutbound = new Map();

let botWhatsAppNumber = config.botWhatsAppNumber || '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Chat id to send into (works when getChat() is broken — common with LID / WA Web).
 * @param {import('whatsapp-web.js').Message} message
 */
function resolveOutboundChatId(message) {
  if (message.fromMe) {
    return message.to || message.from || null;
  }
  return message.from || message.to || null;
}

/**
 * Reply and remember body so fromMe echo is not treated as user input.
 * Prefer reply(); never depend only on getChat (it often throws "n" on current WA Web).
 * @param {import('whatsapp-web.js').Message} message
 * @param {string} phone
 * @param {string} text
 */
async function botReply(message, phone, text) {
  const body = String(text);
  lastBotOutbound.set(phone, { body: body.trim(), at: Date.now() });

  try {
    return await message.reply(body);
  } catch (err) {
    console.warn('message.reply failed:', err && err.message ? err.message : err);
  }

  const chatId = resolveOutboundChatId(message);
  if (chatId && !isBlockedChatId(chatId)) {
    try {
      return await client.sendMessage(chatId, body);
    } catch (err) {
      console.warn('client.sendMessage failed:', err && err.message ? err.message : err);
    }
  }

  try {
    const chat = await message.getChat();
    return await chat.sendMessage(body);
  } catch (err) {
    console.error(
      'botReply all methods failed phone=',
      phone,
      'chatId=',
      chatId,
      err && err.message ? err.message : err
    );
  }
  return null;
}

/**
 * True if this fromMe message is the bot's own recent reply (echo).
 */
function isBotEcho(phone, rawText, fromMe) {
  if (!fromMe) return false;
  const last = lastBotOutbound.get(phone);
  if (!last) return false;
  if (Date.now() - last.at > 20000) return false;
  const a = String(rawText || '').trim();
  const b = String(last.body || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  // Multi-line prompt: match first line
  if (a.split(/\r?\n/)[0] === b.split(/\r?\n/)[0] && b.includes('\n')) return true;
  return false;
}

function explorerTxUrl(hash) {
  return chainTxUrl(chain, hash);
}

function explorerAddressUrl(address) {
  return chainAddressUrl(chain, address);
}

/** Canonical phone / id digits (shared with claims join key). */
function normalizePhone(from) {
  return normalizePhoneNumber(from);
}

/**
 * Best-effort real phone from WhatsApp message context.
 * Prefers getContactLidAndPhone (pn alongside LID). Never invents a number.
 * @param {import('whatsapp-web.js').Message} message
 * @returns {Promise<string|null>} normalized digits or null
 */
async function extractPhoneFromWaMessage(message) {
  const chatId = message.fromMe ? message.to || message.from : message.from;
  if (!chatId) return null;

  // LID + phone pair (whatsapp-web.js)
  try {
    if (typeof client.getContactLidAndPhone === 'function') {
      const pairs = await client.getContactLidAndPhone([String(chatId)]);
      const pn = pairs && pairs[0] && pairs[0].pn;
      if (pn) {
        const digits = normalizePhoneNumber(pn);
        if (isPlausiblePhone(digits)) return digits;
      }
    }
  } catch (err) {
    console.warn('getContactLidAndPhone:', publicErrorMessage(err));
  }

  // Already a classic phone wid
  if (String(chatId).includes('@c.us')) {
    const digits = normalizePhoneNumber(chatId);
    if (isPlausiblePhone(digits)) return digits;
  }

  try {
    const contact = await message.getContact();
    const serialized = String(contact?.id?._serialized || '');
    const server = String(contact?.id?.server || '');
    if (server === 'c.us' || serialized.includes('@c.us')) {
      const digits = normalizePhoneNumber(contact.number || contact.id?.user || '');
      if (isPlausiblePhone(digits)) return digits;
    }
  } catch (err) {
    console.warn('getContact phone:', publicErrorMessage(err));
  }

  return null;
}

/**
 * Resolve phone join key for claims/requests: extract from message, store on identity.
 * LID (phone param) stays the identity key.
 * @returns {Promise<{ waSenderId: string, waPhone: string|null }>}
 */
async function resolveClaimIdentity(message, waSenderId) {
  let waPhone = null;
  try {
    waPhone = await extractPhoneFromWaMessage(message);
  } catch (err) {
    console.warn('extractPhoneFromWaMessage:', publicErrorMessage(err));
  }

  if (waPhone) {
    try {
      await setIdentityPhone(waSenderId, waPhone);
    } catch (err) {
      console.warn('setIdentityPhone:', publicErrorMessage(err));
    }
  } else {
    try {
      const bound = await getAccountByWaSender(waSenderId);
      if (bound?.identity?.wa_phone_e164) {
        waPhone = normalizePhoneNumber(bound.identity.wa_phone_e164);
      }
    } catch (err) {
      console.warn('resolveClaimIdentity lookup:', publicErrorMessage(err));
    }
  }

  return { waSenderId, waPhone: waPhone || null };
}

function formatEth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  if (n < 0.000001) return n.toExponential(4);
  return n.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * send 0.01 to 0x... | send 0.01 to ama | send 0.01 to 2348012345678
 * @returns {{ amountEth: string, toRaw: string, isAddress: boolean, isPhone: boolean } | null}
 */
function parseSendCommand(text) {
  const addr = text.match(
    /send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(0x[a-fA-F0-9]{40})\b/i
  );
  if (addr) {
    return { amountEth: addr[1], toRaw: addr[2], isAddress: true, isPhone: false };
  }
  const phone = text.match(
    /send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(\+?\d{10,15})\b/i
  );
  if (phone) {
    return {
      amountEth: phone[1],
      toRaw: phone[2],
      isAddress: false,
      isPhone: true,
    };
  }
  const alias = text.match(
    /send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\b/i
  );
  if (alias) {
    return { amountEth: alias[1], toRaw: alias[2], isAddress: false, isPhone: false };
  }
  return null;
}

/**
 * flizy buy 0.01 FLZ | flizy sell 10 FLZ | flizy swap 0.01 ETH for FLZ | flizy price FLZ
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

  m = t.match(
    /^swap\s+([0-9]*\.?[0-9]+)\s+([a-zA-Z0-9]+)\s+for\s+([a-zA-Z0-9]+)\s*$/i
  );
  if (m) return { kind: 'swap', amount: m[1], tokenIn: m[2], tokenOut: m[3] };

  return null;
}

/** flizy cancel claims | flizy cancel claims 234... | flizy cancel claims all */
function parseCancelClaimsCommand(text) {
  const m = String(text || '').trim().match(
    /^cancel\s+claims?(?:\s+(\+?\d{6,20}|all))?\s*$/i
  );
  if (!m) return null;
  const arg = m[1] ? String(m[1]).toLowerCase() : null;
  return { filter: arg === 'all' ? null : arg };
}

/** flizy claims (list outgoing) | flizy claim / flizy claim incoming */
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

/**
 * request 0.01 from 234… | request 0.01 from john | request 0.01 eth from john
 */
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

/** flizy requests | flizy pay | flizy cancel requests */
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
  const m = text.match(
    /^(?:save|add|contact)\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\s+(0x[a-fA-F0-9]{40})\s*$/i
  );
  if (!m) return null;
  return { alias: m[1].toLowerCase(), address: m[2] };
}

/** remove ama | unsave ama | delete ama */
function parseRemoveContactCommand(text) {
  const m = text.match(/^(?:remove|unsave|delete)\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\s*$/i);
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

function isContactsListCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'contacts' || t === 'list' || t === 'names' || t === 'addressbook';
}

/** Command body after optional flizy prefix. */
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
 * Raw WhatsApp text.
 * Normally requires "flizy ..." but bare confirm/cancel always work so a pending
 * send is not stuck if the user omits the prefix.
 */
function isFlizyCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/^flizy\b/i.test(raw)) {
    const stripped = stripFlizyPrefix(raw, { requirePrefix: true });
    return stripped.ok && (stripped.body === '' || isFlizyCommandBody(stripped.body));
  }
  // Mid-flow replies without prefix
  if (isConfirmCommand(raw) || isCancelCommand(raw)) return true;
  if (config.requireFlizyPrefix) return false;
  return isFlizyCommandBody(raw);
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

/**
 * When hard-locked, only unlock (and unlock password reply) may run.
 * Link still allowed so a locked user can re-bind if needed.
 */
function isAllowedWhenLocked(body) {
  return (
    Boolean(parseUnlockCommand(body)) ||
    Boolean(parseLinkCommand(body)) ||
    parseLockCommand(body)
  );
}

/** credit 234xxx 0.01  |  credit 0.01 to 234xxx */
function parseCreditCommand(text) {
  let m = text.match(/^credit\s+(\d{6,20})\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s*$/i);
  if (m) return { phone: m[1], amountEth: m[2] };
  m = text.match(/^credit\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(\d{6,20})\s*$/i);
  if (m) return { phone: m[2], amountEth: m[1] };
  return null;
}

function isConfirmCommand(text) {
  const t = text.trim().toLowerCase();
  // Only explicit confirm, not yes/y (too easy to trigger by accident)
  return t === 'confirm';
}

function isCancelCommand(text) {
  const t = text.trim().toLowerCase();
  // Only explicit cancel, not no/n
  return t === 'cancel';
}

function isHelpCommand(text) {
  const t = text.trim().toLowerCase();
  // Explicit opt-in only. Casual "hi"/"hello" must NOT wake the bot.
  return t === 'help' || t === 'start' || t === 'menu' || t === 'flizy';
}

function isBalanceCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'balance' || t === 'bal';
}

function isDepositCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'deposit' || t === 'fund' || t === 'topup' || t === 'top up';
}

function isHistoryCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'history' || t === 'txs' || t === 'transfers';
}

function isMeCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'me' || t === 'whoami' || t === 'account';
}

function isPoolCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'pool' || t === 'hotwallet' || t === 'botbalance';
}

function isEscrowCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'escrow' || t === 'claims escrow' || t === 'claimescrow';
}

function isUsersCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'users' || t === 'listusers';
}

function isHowCommand(text) {
  const t = text.trim().toLowerCase();
  return t === 'how' || t === 'howto' || t === 'how to' || t === 'invite' || t === 'share';
}

/** claimadmin <secret> promotes yourself if ADMIN_SETUP_SECRET matches */
function parseClaimAdminCommand(text) {
  const m = text.match(/^claimadmin\s+(\S+)\s*$/i);
  if (!m) return null;
  return { secret: m[1] };
}

/** link A7K2QX (body after flizy prefix stripped) */
function parseLinkCommand(text) {
  const m = text.match(/^link\s+([A-Za-z0-9]{6,12})\s*$/i);
  if (!m) return null;
  return { code: m[1].toUpperCase() };
}

function pruneExpiredPending() {
  const now = Date.now();
  for (const [phone, pending] of pendingSends.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pendingSends.delete(phone);
    }
  }
  for (const [phone, pending] of pendingWalletAdds.entries()) {
    if (now - pending.createdAt > PENDING_TTL_MS) {
      pendingWalletAdds.delete(phone);
    }
  }
  for (const [phone, menu] of pendingClaimMenus.entries()) {
    if (now - menu.createdAt > PENDING_TTL_MS) {
      pendingClaimMenus.delete(phone);
    }
  }
  for (const [phone, wait] of pendingUnlocks.entries()) {
    if (now - wait.createdAt > PENDING_TTL_MS) {
      pendingUnlocks.delete(phone);
    }
  }
}

function isAdminUser(user) {
  return Boolean(user?.is_admin) || ADMIN_PHONES.has(normalizePhone(user?.phone));
}

async function getBotBalanceEth() {
  const balanceWei = await provider.getBalance(wallet.address);
  return ethers.formatEther(balanceWei);
}

async function getOrCreateUser(phone) {
  const digits = normalizePhone(phone);

  // Phase 1: ensure permanent account + whatsapp_identities row (LID-first)
  try {
    await getOrCreateAccountForSender(digits);
  } catch (err) {
    console.error('account bridge:', publicErrorMessage(err));
  }

  const { data: existing, error: selectError } = await supabase
    .from('users')
    .select('id, phone, wallet_address, balance_eth, is_admin, display_name, created_at, account_id')
    .eq('phone', digits)
    .maybeSingle();

  if (selectError) {
    throw new Error(`Supabase select users failed: ${selectError.message}`);
  }

  if (existing) {
    if (ADMIN_PHONES.has(digits) && !existing.is_admin) {
      const { data: promoted, error: promoErr } = await supabase
        .from('users')
        .update({ is_admin: true })
        .eq('id', existing.id)
        .select('id, phone, wallet_address, balance_eth, is_admin, display_name, created_at, account_id')
        .single();
      if (!promoErr && promoted) return { user: promoted, isNew: false };
    }
    return { user: existing, isNew: false };
  }

  const { data: created, error: insertError } = await supabase
    .from('users')
    .insert({
      phone: digits,
      is_admin: ADMIN_PHONES.has(digits),
      balance_eth: 0,
    })
    .select('id, phone, wallet_address, balance_eth, is_admin, display_name, created_at, account_id')
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      const { data: raced, error: raceError } = await supabase
        .from('users')
        .select('id, phone, wallet_address, balance_eth, is_admin, display_name, created_at, account_id')
        .eq('phone', digits)
        .single();
      if (raceError) throw new Error(`Supabase reselect users failed: ${raceError.message}`);
      return { user: raced, isNew: false };
    }
    throw new Error(`Supabase insert users failed: ${insertError.message}`);
  }

  return { user: created, isNew: true };
}

async function setUserBalance(userId, newBalanceEth) {
  const { data, error } = await supabase
    .from('users')
    .update({ balance_eth: newBalanceEth })
    .eq('id', userId)
    .select('id, phone, wallet_address, balance_eth, is_admin, display_name, created_at')
    .single();
  if (error) throw new Error(`Balance update failed: ${error.message}`);
  return data;
}

/**
 * Resolve 0x... or a name from:
 * 1) WhatsApp contacts table (flizy save)
 * 2) Site trusted_addresses.label (dashboard)
 */
async function resolveSendTarget(ownerPhone, toRaw, isAddress, accountId) {
  if (isAddress) {
    if (!ethers.isAddress(toRaw)) return { error: 'Invalid address.' };
    return { address: ethers.getAddress(toRaw), label: null };
  }

  const alias = String(toRaw).toLowerCase();

  const { data: contact, error: cErr } = await supabase
    .from('contacts')
    .select('alias, address')
    .eq('owner_phone', ownerPhone)
    .eq('alias', alias)
    .maybeSingle();
  if (cErr) return { error: `Contact lookup failed: ${cErr.message}` };

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
      `WhatsApp: flizy save ${alias} 0xYourAddress`,
      `List: flizy contacts`,
    ].join('\n'),
  };
}

async function saveContact(user, ownerPhone, alias, address) {
  if (!ethers.isAddress(address)) {
    throw new Error('Invalid address. Use 0x + 40 hex characters.');
  }
  const checksum = ethers.getAddress(address);
  const row = {
    user_id: user.id,
    owner_phone: ownerPhone,
    alias: alias.toLowerCase(),
    address: checksum,
  };
  const { data, error } = await supabase
    .from('contacts')
    .upsert(row, { onConflict: 'owner_phone,alias' })
    .select('alias, address')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function removeContact(ownerPhone, alias) {
  const { data, error } = await supabase
    .from('contacts')
    .delete()
    .eq('owner_phone', ownerPhone)
    .eq('alias', alias.toLowerCase())
    .select('alias')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function listContacts(ownerPhone) {
  const { data, error } = await supabase
    .from('contacts')
    .select('alias, address')
    .eq('owner_phone', ownerPhone)
    .order('alias', { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  return data || [];
}

function howOthersUseText() {
  const numberLine = botWhatsAppNumber
    ? `Bot number: +${botWhatsAppNumber}`
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

function helpText(user) {
  const lines = [
    'Flizy: GIWA Sepolia via WhatsApp',
    '',
    'Prefix every command with flizy',
    '  flizy help',
    '  flizy link CODE',
    '  flizy me',
    '  flizy balance',
    '  flizy history',
    '  flizy deposit',
    '  flizy add wallet 0x...',
    '  flizy send 0.01 to john',
    '  flizy send 0.01 to 2348012345678',
    '  confirm',
    '  cancel',
    '',
    'Session lock (stop tampering if phone is shared):',
    '  flizy lock            → lock now (no password)',
    '  flizy unlock          → bot asks for password / PIN',
    '  (while locked, other flizy commands are blocked)',
    '',
    'Swap (agent wallet, fee disclosed before confirm):',
    '  flizy buy 0.01 FLZ       → spend ETH for FLZ',
    '  flizy sell 10 FLZ        → sell FLZ for ETH',
    '  flizy swap 0.01 ETH for FLZ',
    '  flizy price FLZ',
    '  (add liquidity on the site only)',
    '',
    'Claims (phone not on Flizy yet):',
    '  flizy send 0.01 to 234…  → hold until they link WA',
    '  flizy cancel claims       → cancel anytime (1/2/3/All)',
    '  flizy claim               → receive after you link WA',
    '',
    'Requests (ask for money):',
    '  flizy request 0.01 from 234…',
    '  flizy pay                 → pay requests to you',
    '  flizy requests            → cancel your open requests',
    '',
    'Add wallet from chat:',
    '  flizy add wallet 0xYourAddress',
    '  (bot asks for a name)',
    '  john',
    '  -> added',
    '',
    'Setup:',
    '  1) Create account on the site',
    '  2) flizy link CODE',
    '  3) flizy send 0.0001 to john',
    '',
    `Site: ${config.siteUrl}`,
    `Chain: ${chain.name} (${chain.chainId})`,
    '',
    'On-chain sends are irreversible. Phone claims are cancellable until claimed.',
    'Swaps charge a protocol fee shown in the plan (plus network gas).',
  ];
  return lines.join('\n');
}

function welcomeText(user) {
  return [
    'Welcome to Flizy',
    '',
    'You are registered for GIWA Sepolia test transfers.',
    `Your id: ${user.phone}`,
    `Credit: ${formatEth(user.balance_eth)} ETH`,
    '',
    'Prefix every command with flizy',
    '  flizy help',
    '  flizy lock           (block bot until unlock)',
    '  flizy unlock         (bot asks for password)',
    '  flizy send 0.001 to ama',
    '',
    `Site: ${config.siteUrl}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleHelp(message, user) {
  await message.reply(helpText(user));
}

async function handleHow(message) {
  await message.reply(howOthersUseText());
}

/**
 * Always show the permanent site agent wallet after link.
 * Unlinked WhatsApp must not invent a second address.
 */
async function resolveLinkedSiteAccount(phone, account) {
  const linked = await getAccountByWaSender(phone);
  if (linked?.account?.email) {
    return ensureAgentWallet(linked.account.id);
  }
  if (account?.email) {
    return ensureAgentWallet(account.id);
  }
  return null;
}

async function handleMe(message, user, account) {
  try {
    const acc = await resolveLinkedSiteAccount(phoneFromUser(user, account), account);
    // phone is on user.phone
    const waId = user.phone;
    if (!acc) {
      await botReply(
        message,
        waId,
        [
          'Link your site account to see your permanent agent wallet.',
          `Site: ${config.siteUrl}/dashboard`,
          'Generate a code, then: flizy link CODE',
          '',
          `WhatsApp id: ${waId}`,
        ].join('\n')
      );
      return;
    }
    await botReply(
      message,
      waId,
      [
        'Your Flizy account',
        acc.email ? `Email: ${acc.email}` : null,
        acc.display_name ? `Name: ${acc.display_name}` : null,
        `Agent wallet: ${acc.agent_wallet_address}`,
        `WhatsApp id: ${waId}`,
        '',
        'Tip: flizy balance  |  flizy history',
      ]
        .filter(Boolean)
        .join('\n')
    );
  } catch (err) {
    await botReply(
      message,
      user.phone,
      [
        'Your Flizy account',
        `WhatsApp id: ${user.phone}`,
        'Could not load wallet. Try flizy link CODE from the dashboard.',
      ].join('\n')
    );
  }
}

function phoneFromUser(user, account) {
  return user?.phone || account?.phone || '';
}

async function handleDeposit(message, user, account) {
  const lines = [
    'Fund your own agent wallet',
    '',
    'Sends are signed from YOUR site agent wallet, not the bot ops key.',
    '',
  ];
  try {
    const acc = await resolveLinkedSiteAccount(user.phone, account);
    if (acc?.agent_wallet_address) {
      lines.push(`Your agent wallet: ${acc.agent_wallet_address}`);
      lines.push(explorerAddressUrl(acc.agent_wallet_address));
      const bal = await provider.getBalance(acc.agent_wallet_address);
      lines.push(`Balance: ${formatEth(ethers.formatEther(bal))} ETH`);
    } else {
      lines.push(`Link your site account first: ${config.siteUrl}/dashboard`);
      lines.push('Then: flizy link CODE');
    }
  } catch {
    lines.push('Could not load agent wallet. Try flizy me');
  }
  lines.push(
    '',
    '1. Send GIWA Sepolia ETH to your agent wallet above',
    '2. flizy add wallet 0x... (or add trusted on site)',
    '3. flizy send 0.0001 to name',
    '4. confirm',
    '',
    `Your WhatsApp id: ${user.phone}`
  );
  await message.reply(lines.join('\n'));
}

async function handleBalance(message, user, account) {
  try {
    const acc = await resolveLinkedSiteAccount(user.phone, account);
    if (!acc) {
      await message.reply(
        [
          'Link your site account to see your permanent agent wallet.',
          `Site: ${config.siteUrl}/dashboard`,
          'Generate a code, then: flizy link CODE',
        ].join('\n')
      );
      return;
    }
    const credit = formatEth(acc?.balance_eth != null ? acc.balance_eth : user.balance_eth);
    let holdings = null;
    if (acc?.agent_wallet_address) {
      holdings = await getWalletHoldings(acc.agent_wallet_address, chain);
    }
    const text = formatHoldingsMessage({
      credit,
      agentWallet: acc?.agent_wallet_address || null,
      holdings,
      showCredit: config.enforceCredit,
    });
    await message.reply(text);
  } catch (err) {
    console.error('balance error:', err);
    await message.reply(
      `Your credit: ${formatEth(user.balance_eth)} ETH\n(Could not read holdings right now.)`
    );
  }
}

async function handleHistory(message, phone) {
  const { data, error } = await supabase
    .from('transfers')
    .select('amount_eth, to_address, status, tx_hash, created_at')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('history error:', error);
    await message.reply('Could not load history right now.');
    return;
  }

  if (!data || data.length === 0) {
    await message.reply('No transfers yet. Try: send 0.001 to 0x...');
    return;
  }

  const lines = ['Last 10 transfers:'];
  for (const row of data) {
    const shortTo = shortAddress(row.to_address);
    lines.push(
      `• ${formatEth(row.amount_eth)} ETH → ${shortTo} [${row.status}]`
    );
    if (row.tx_hash) lines.push(`  ${explorerTxUrl(row.tx_hash)}`);
  }
  await message.reply(lines.join('\n'));
}

async function handlePool(message, user) {
  if (!isAdminUser(user)) {
    await message.reply('Pool is admin-only. Use "balance" for your credit.');
    return;
  }
  try {
    const pool = await getBotBalanceEth();
    await message.reply(
      [
        'Ops wallet (gas / infra — not claim escrow)',
        `${formatEth(pool)} ETH`,
        wallet.address,
        explorerAddressUrl(wallet.address),
        '',
        'Claim escrow: flizy escrow',
      ].join('\n')
    );
  } catch (err) {
    console.error('pool error:', err);
    await message.reply('Could not read pool balance.');
  }
}

async function handleEscrow(message, user) {
  if (!isAdminUser(user)) {
    await message.reply('Escrow status is admin-only.');
    return;
  }
  try {
    const text = await formatEscrowStatus(provider);
    await botReply(
      message,
      user.phone,
      [text, explorerAddressUrl(escrowWallet.address)].join('\n')
    );
  } catch (err) {
    console.error('escrow status:', publicErrorMessage(err));
    await message.reply('Could not read escrow status.');
  }
}

async function handleUsers(message, user) {
  if (!isAdminUser(user)) {
    await message.reply('Users list is admin-only.');
    return;
  }
  const { data, error } = await supabase
    .from('users')
    .select('phone, balance_eth, is_admin, created_at')
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) {
    await message.reply('Could not list users.');
    return;
  }
  if (!data?.length) {
    await message.reply('No users yet.');
    return;
  }

  const lines = ['Recent users:'];
  for (const u of data) {
    lines.push(
      `• ${u.phone}  credit=${formatEth(u.balance_eth)}  ${u.is_admin ? 'admin' : 'user'}`
    );
  }
  await message.reply(lines.join('\n'));
}

async function handleClaimAdmin(message, user, secret) {
  const expected = config.adminSetupSecret;
  if (!expected || expected === 'changeme') {
    await message.reply(
      'Admin setup is not configured.\nSet ADMIN_SETUP_SECRET in .env (not "changeme"), restart, then:\nclaimadmin your-secret'
    );
    return;
  }
  if (secret !== expected) {
    await message.reply('Invalid setup secret.');
    return;
  }
  if (user.is_admin) {
    await message.reply('You are already an admin.');
    return;
  }
  const { data, error } = await supabase
    .from('users')
    .update({ is_admin: true })
    .eq('id', user.id)
    .select('phone, is_admin')
    .single();
  if (error) {
    await message.reply(`Could not promote: ${error.message}`);
    return;
  }
  await message.reply(
    [
      'You are now an admin.',
      `Phone id: ${data.phone}`,
      '',
      'You can:',
      '  credit <phoneId> 0.01',
      '  pool',
      '  users',
      '',
      'Friends message this WhatsApp number, then you credit their id from "users" or their "me" reply.',
    ].join('\n')
  );
}

async function handleCredit(message, adminUser, targetPhone, amountEth) {
  if (!isAdminUser(adminUser)) {
    await message.reply('Only admins can credit balances.');
    return;
  }

  let amount;
  try {
    amount = Number(amountEth);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('bad amount');
    ethers.parseEther(String(amountEth));
  } catch {
    await message.reply('Invalid amount. Example: credit 2348012345678 0.01');
    return;
  }

  const phone = normalizePhone(targetPhone);
  if (phone.length < 6) {
    await message.reply('Invalid phone. Use digits with country code, no +.\nExample: credit 2348012345678 0.01');
    return;
  }

  try {
    const { user: target } = await getOrCreateUser(phone);
    const next = Number(target.balance_eth || 0) + amount;
    const updated = await setUserBalance(target.id, next);
    await message.reply(
      [
        'Credit added.',
        `User: ${updated.phone}`,
        `Added: ${formatEth(amount)} ETH`,
        `New credit: ${formatEth(updated.balance_eth)} ETH`,
        '',
        'They can now: send 0.001 to 0x... then confirm',
      ].join('\n')
    );
  } catch (err) {
    console.error('credit error:', err);
    await message.reply(`Credit failed: ${err.message}`);
  }
}

async function requireLinkedSite(message, phone, account) {
  const siteAcc = await resolveLinkedSiteAccount(phone, account);
  if (!siteAcc?.id) {
    await botReply(
      message,
      phone,
      [
        'Link your site account first.',
        `Open ${config.siteUrl}/dashboard`,
        'Generate a code, then send:',
        'flizy link CODE',
      ].join('\n')
    );
    return null;
  }
  return siteAcc;
}

async function actorSessionFlags(user, siteAcc, phone) {
  let sessionUnlocked = true;
  if (config.requireUnlock && siteAcc.unlock_pin_hash && !isAdminUser(user)) {
    sessionUnlocked = await isSessionUnlocked(siteAcc.id, phone);
  }
  return {
    accountId: siteAcc.id,
    userId: user.id,
    waSenderId: phone,
    isAdmin: isAdminUser(user),
    creditEth: Number(user.balance_eth || 0),
    sessionUnlocked,
    hasPin: Boolean(siteAcc.unlock_pin_hash),
  };
}

/**
 * SEND path: trusted/address on-chain OR phone claim hold.
 */
async function handleSend(message, user, phone, amountEth, toRaw, isAddress, isPhone, account) {
  const siteAcc = await requireLinkedSite(message, phone, account);
  if (!siteAcc) return;

  // --- Phone: claim hold (or direct if that WA already linked) ---
  if (isPhone) {
    const toWa = normalizeWaHint(toRaw);
    if (!isPlausiblePhone(toWa)) {
      await botReply(
        message,
        phone,
        'Invalid phone. Use country code digits.\nExample: flizy send 0.001 to 2348012345678'
      );
      return;
    }
    if (toWa === normalizeWaHint(phone)) {
      await botReply(message, phone, 'You cannot send a claim to your own WhatsApp number.');
      return;
    }

    const linkedPeer = await getAccountByWaSender(toWa);
    if (linkedPeer?.account?.id && linkedPeer.account.email) {
      // Already on Flizy with site account → direct to their agent wallet (no trusted required)
      const peerAcc = await ensureAgentWallet(linkedPeer.account.id);
      const toAddress = peerAcc.agent_wallet_address;
      if (!toAddress) {
        await botReply(message, phone, 'That user has no agent wallet yet. Try again later.');
        return;
      }
      return handleSendResolved(message, user, phone, amountEth, {
        address: ethers.getAddress(toAddress),
        label: `+${toWa}`,
      }, siteAcc, { skipTrusted: true });
    }

    // Not linked → claim plan (held until that WhatsApp links)
    const actor = await actorSessionFlags(user, siteAcc, phone);
    const intent = createSendIntent({
      actor,
      amountEth,
      toAddress: null,
      toLabel: `+${toWa}`,
      toRaw: toWa,
      toIsAddress: false,
      chainId: String(chain.chainId),
    });

    const policy = await evaluateClaimHoldPolicy(intent, { accountRow: siteAcc });
    if (policy.decision === 'DENY') {
      await botReply(message, phone, policy.message || 'Not allowed.');
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
      await botReply(message, phone, 'Could not check your agent wallet. Try again shortly.');
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
      await botReply(
        message,
        phone,
        [funded.message, explorerAddressUrl(fromAddress)].filter(Boolean).join('\n')
      );
      return;
    }

    pendingSends.set(phone, { plan, createdAt: Date.now() });
    await botReply(message, phone, formatClaimPlanPreview(plan));
    return;
  }

  // --- Address or trusted name ---
  const resolved = await resolveSendTarget(phone, toRaw, isAddress, siteAcc.id);
  if (resolved.error) {
    await botReply(message, phone, resolved.error);
    return;
  }
  return handleSendResolved(message, user, phone, amountEth, resolved, siteAcc, {
    skipTrusted: false,
  });
}

async function handleSendResolved(message, user, phone, amountEth, resolved, siteAcc, opts = {}) {
  const actor = await actorSessionFlags(user, siteAcc, phone);
  const intent = createSendIntent({
    actor,
    amountEth,
    toAddress: resolved.address,
    toLabel: resolved.label,
    toIsAddress: true,
    chainId: String(chain.chainId),
  });

  const policy = await evaluateSendPolicy(intent, {
    enforceTrusted: opts.skipTrusted ? false : config.enforceTrusted,
    accountRow: siteAcc,
  });
  if (policy.decision === 'DENY') {
    await botReply(message, phone, policy.message || 'Not allowed.');
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
    await botReply(message, phone, 'Could not check your agent wallet on-chain. Try again shortly.');
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
  });
  if (opts.paymentRequestId) {
    plan.paymentRequestId = opts.paymentRequestId;
  }

  const funded = assertPlanFunded(plan, fromBalanceEth);
  if (!funded.ok) {
    await botReply(
      message,
      phone,
      [funded.message, explorerAddressUrl(fromAddress)].filter(Boolean).join('\n')
    );
    return;
  }

  pendingSends.set(phone, {
    plan,
    createdAt: Date.now(),
    paymentRequestId: opts.paymentRequestId || null,
  });
  await botReply(message, phone, formatPlanPreview(plan));
}

async function handleConfirm(message, user, phone) {
  pruneExpiredPending();
  const pending = pendingSends.get(phone);

  if (!pending) {
    return;
  }

  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingSends.delete(phone);
    await botReply(message, phone, 'Transfer plan expired. Start again with flizy send ...');
    return;
  }

  const plan = pending.plan;
  const paymentRequestId = pending.paymentRequestId || plan.paymentRequestId || null;
  pendingSends.delete(phone);

  if (!plan) {
    await botReply(message, phone, 'Nothing to confirm. Start with flizy send ...');
    return;
  }

  let fresh = user;
  try {
    const res = await getOrCreateUser(phone);
    fresh = res.user;
  } catch (err) {
    console.error('confirm re-fetch user:', err);
  }

  if (plan.intent === 'CLAIM_HOLD') {
    await botReply(message, phone, 'Holding funds for claim...');
    const result = await executeClaimHold({
      fromAccountId: plan.actor.accountId,
      fromWaSender: phone,
      toWaHint: plan.route.toWaHint || plan.input.toWaHint,
      amountEth: plan.input.amount,
      provider,
      chain,
      escrowWallet,
    });
    if (!result.ok) {
      await botReply(message, phone, result.error || 'Claim hold failed.');
      return;
    }
    await botReply(
      message,
      phone,
      [
        'Claim held.',
        `${plan.input.amount} ${plan.input.asset} reserved for ${plan.input.recipient}`,
        '',
        'They receive only after that WhatsApp links Flizy.',
        'Cancel anytime: flizy cancel claims',
        '',
        'Share claim link (optional):',
        result.claimUrl,
        '',
        result.explorerUrl || '',
      ]
        .filter(Boolean)
        .join('\n')
    );
    return;
  }

  if (plan.intent === 'SWAP') {
    await botReply(message, phone, 'Submitting swap...');
    const result = await executeSwapPlan({ plan, provider, chain });
    if (!result.ok) {
      await botReply(message, phone, result.error || 'Swap failed.');
      return;
    }
    await botReply(message, phone, 'Swap submitted. Waiting for confirmation...');
    await botReply(message, phone, formatSwapReceipt(result, plan));
    return;
  }

  await botReply(message, phone, 'Executing transfer...');

  const result = await executeNativeSend({
    plan,
    provider,
    chain,
    user: fresh,
    setUserBalance,
    supabase,
  });

  if (result.ok && paymentRequestId) {
    try {
      await markRequestPaid(paymentRequestId, plan.actor.accountId, result.txHash || null);
    } catch (err) {
      console.warn('markRequestPaid:', publicErrorMessage(err));
    }
  }

  await botReply(message, phone, formatSendReceipt(result, plan));
}

async function handleCancel(message, phone) {
  if (pendingClaimMenus.has(phone)) {
    pendingClaimMenus.delete(phone);
    await botReply(message, phone, 'Menu closed.');
    return true;
  }
  if (pendingSends.has(phone)) {
    pendingSends.delete(phone);
    await botReply(message, phone, 'Plan cancelled. Nothing was executed.');
    return true;
  }
  return false;
}

/**
 * flizy buy / sell / swap / price
 */
async function handleSwapCommand(message, user, phone, account, parsed) {
  if (parsed.kind === 'price') {
    try {
      const sym = String(parsed.symbol || 'FLZ').toUpperCase();
      if (sym !== 'FLZ' && sym !== 'FLIZY') {
        await botReply(message, phone, 'Price supported for FLZ.\nExample: flizy price FLZ');
        return;
      }
      const px = await getFlzPrice(provider, chain.id);
      await botReply(
        message,
        phone,
        [
          'FLZ price (pool)',
          `1 ETH ≈ ${formatEth(px.flzPerEth)} FLZ`,
          `1 FLZ ≈ ${formatEth(px.ethPerFlz)} ETH`,
          `Reserves: ${formatEth(px.reserveWeth)} ETH / ${formatEth(px.reserveFlz)} FLZ`,
          `Chain: ${chain.name}`,
        ].join('\n')
      );
    } catch (err) {
      console.error('price:', publicErrorMessage(err));
      await botReply(message, phone, 'Could not read price. Try again shortly.');
    }
    return;
  }

  const siteAcc = await requireLinkedSite(message, phone, account);
  if (!siteAcc) return;

  const dex = getDexConfig(chain.id);
  if (!dex.feeRouter || !dex.flz) {
    await botReply(message, phone, 'Swap not configured on this chain yet.');
    return;
  }

  let tokenInLabel;
  let tokenOutLabel;
  let tokenIn;
  let tokenOut;
  let amountStr = parsed.amount;

  try {
    if (parsed.kind === 'buy') {
      // spend native ETH for tokenOut
      tokenInLabel = 'ETH';
      tokenOutLabel = tokenLabel(parsed.tokenOut, chain.id);
      tokenIn = null;
      tokenOut = resolveToken(parsed.tokenOut, chain.id);
      if (tokenOut === null) {
        await botReply(message, phone, 'Buy target must be a token (e.g. FLZ), not ETH.');
        return;
      }
    } else if (parsed.kind === 'sell') {
      tokenInLabel = tokenLabel(parsed.tokenIn, chain.id);
      tokenOutLabel = 'ETH';
      tokenIn = resolveToken(parsed.tokenIn, chain.id);
      tokenOut = null;
      if (tokenIn === null) {
        await botReply(message, phone, 'Sell input must be a token (e.g. FLZ), not ETH.');
        return;
      }
    } else {
      tokenInLabel = tokenLabel(parsed.tokenIn, chain.id);
      tokenOutLabel = tokenLabel(parsed.tokenOut, chain.id);
      const rawIn = String(parsed.tokenIn || '').toUpperCase();
      const rawOut = String(parsed.tokenOut || '').toUpperCase();
      tokenIn = rawIn === 'ETH' || rawIn === 'NATIVE' ? null : resolveToken(parsed.tokenIn, chain.id);
      tokenOut = rawOut === 'ETH' || rawOut === 'NATIVE' ? null : resolveToken(parsed.tokenOut, chain.id);
    }
  } catch (err) {
    await botReply(message, phone, err.message || 'Unknown token.');
    return;
  }

  let amountInWei;
  try {
    amountInWei = ethers.parseEther(String(amountStr));
    if (amountInWei <= 0n) throw new Error('bad');
  } catch {
    await botReply(message, phone, 'Invalid amount.\nExample: flizy buy 0.01 FLZ');
    return;
  }

  const unlocked = await isSessionUnlocked(siteAcc.id);
  const intent = createSwapIntent({
    actor: {
      accountId: siteAcc.id,
      waSenderId: phone,
      isAdmin: Boolean(siteAcc.is_admin || user?.is_admin),
      sessionUnlocked: unlocked,
      hasPin: Boolean(siteAcc.unlock_pin_hash),
    },
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
    await botReply(message, phone, policy.message || 'Swap not allowed.');
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
    await botReply(
      message,
      phone,
      'Could not quote swap (pool or amount issue). Try a smaller amount or flizy price FLZ.'
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

  pendingSends.set(phone, { plan, createdAt: Date.now() });
  await botReply(message, phone, formatSwapPlanPreview(plan));
}

/**
 * flizy cancel claims [phone|all]
 */
async function handleCancelClaims(message, user, phone, account, filter) {
  const siteAcc = await requireLinkedSite(message, phone, account);
  if (!siteAcc) return;

  const phoneFilter =
    filter && filter !== 'all' && isPlausiblePhone(filter) ? normalizeWaHint(filter) : null;

  let claims;
  try {
    claims = await listOutgoingPending(siteAcc.id, phoneFilter || undefined);
  } catch (err) {
    console.error('listOutgoingPending:', publicErrorMessage(err));
    await botReply(message, phone, 'Could not load claims. Try again.');
    return;
  }

  if (!claims.length) {
    await botReply(
      message,
      phone,
      phoneFilter
        ? `No pending claims to +${phoneFilter}.`
        : 'No pending claims.\nSend to a phone: flizy send 0.001 to 2348012345678'
    );
    return;
  }

  if (claims.length === 1) {
    pendingClaimMenus.set(phone, {
      mode: 'cancel',
      claims,
      createdAt: Date.now(),
      awaitConfirmId: claims[0].id,
    });
    await botReply(
      message,
      phone,
      [
        'Cancel this claim?',
        `+${claims[0].to_wa_hint}  ${claims[0].amount_eth} ETH`,
        '',
        'Reply: confirm',
        'Or: cancel',
      ].join('\n')
    );
    return;
  }

  pendingClaimMenus.set(phone, { mode: 'cancel', claims, createdAt: Date.now() });
  await botReply(message, phone, formatClaimsMenu(claims, 'outgoing'));
}

async function handleClaimsList(message, user, phone, account, kind) {
  if (kind === 'outgoing') {
    return handleCancelClaims(message, user, phone, account, null);
  }

  // Incoming: only after this WA is the identity (always true for messager)
  // Surface only when linked to site account (ownership of Flizy account)
  const siteAcc = await resolveLinkedSiteAccount(phone, account);
  if (!siteAcc?.id) {
    await botReply(
      message,
      phone,
      [
        'Link WhatsApp to your Flizy account to see claims for this number.',
        `Open ${config.siteUrl}/dashboard → generate code → flizy link CODE`,
      ].join('\n')
    );
    return;
  }

  let claims;
  try {
    const identity = await resolveClaimIdentity(message, phone);
    claims = await listIncomingPending(identity);
    if (!claims.length && !identity.waPhone) {
      await botReply(
        message,
        phone,
        [
          'No pending claims for this WhatsApp.',
          '',
          'Could not read your phone number from WhatsApp (LID-only session).',
          'Claims are addressed by phone. Re-link after updating the bot, or ask the sender to confirm the number.',
        ].join('\n')
      );
      return;
    }
  } catch (err) {
    console.error('listIncomingPending:', publicErrorMessage(err));
    await botReply(message, phone, 'Could not load claims. Try again.');
    return;
  }

  if (!claims.length) {
    await botReply(message, phone, 'No pending claims for this WhatsApp.');
    return;
  }

  if (claims.length === 1) {
    pendingClaimMenus.set(phone, {
      mode: 'claim',
      claims,
      createdAt: Date.now(),
      awaitConfirmId: claims[0].id,
    });
    await botReply(
      message,
      phone,
      [
        'Receive this claim?',
        `${claims[0].amount_eth} ETH`,
        '',
        'Reply: confirm',
        'Or: cancel',
      ].join('\n')
    );
    return;
  }

  pendingClaimMenus.set(phone, { mode: 'claim', claims, createdAt: Date.now() });
  await botReply(message, phone, formatClaimsMenu(claims, 'incoming'));
}

/**
 * Menu reply: 1 | 2 | All | confirm (for single)
 * modes: cancel | claim | pay_request | cancel_request
 */
async function handleClaimMenuReply(message, user, phone, account, text) {
  const menu = pendingClaimMenus.get(phone);
  if (!menu) return false;

  const t = String(text || '').trim().toLowerCase();
  if (isCancelCommand(t)) {
    pendingClaimMenus.delete(phone);
    await botReply(message, phone, 'Menu closed.');
    return true;
  }

  const list = menu.requests || menu.claims || [];

  // Single-item confirm
  if (menu.awaitConfirmId && isConfirmCommand(t)) {
    pendingClaimMenus.delete(phone);
    if (menu.mode === 'cancel') {
      await runCancelOneClaim(message, phone, account, menu.awaitConfirmId);
    } else if (menu.mode === 'claim') {
      await runPayoutOneClaim(message, user, phone, account, menu.awaitConfirmId);
    } else if (menu.mode === 'pay_request') {
      await startPayRequest(message, user, phone, account, menu.awaitConfirmId);
    } else if (menu.mode === 'cancel_request') {
      await runCancelOneRequest(message, phone, account, menu.awaitConfirmId);
    }
    return true;
  }

  let selected = [];
  if (t === 'all') {
    selected = list.slice();
  } else if (/^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    if (idx < 0 || idx >= list.length) {
      await botReply(message, phone, `Pick 1–${list.length}, All, or cancel.`);
      return true;
    }
    selected = [list[idx]];
  } else {
    return false;
  }

  pendingClaimMenus.delete(phone);

  if (menu.mode === 'cancel') {
    for (const c of selected) await runCancelOneClaim(message, phone, account, c.id);
  } else if (menu.mode === 'claim') {
    for (const c of selected) await runPayoutOneClaim(message, user, phone, account, c.id);
  } else if (menu.mode === 'pay_request') {
    // Pay one at a time (each needs its own confirm plan)
    if (selected.length > 1) {
      await botReply(
        message,
        phone,
        'Pay one request at a time. Reply with a single number, then confirm the plan.'
      );
      pendingClaimMenus.set(phone, { ...menu, createdAt: Date.now() });
      return true;
    }
    await startPayRequest(message, user, phone, account, selected[0].id);
  } else if (menu.mode === 'cancel_request') {
    for (const r of selected) await runCancelOneRequest(message, phone, account, r.id);
  }
  return true;
}

async function runCancelOneClaim(message, phone, account, claimId) {
  const siteAcc = await resolveLinkedSiteAccount(phone, account);
  if (!siteAcc?.id) {
    await botReply(message, phone, 'Link your site account first.');
    return;
  }
  await botReply(message, phone, 'Refunding claim...');
  const result = await executeClaimRefund({
    claimId,
    fromAccountId: siteAcc.id,
    provider,
    chain,
    escrowWallet,
  });
  if (!result.ok) {
    await botReply(message, phone, result.error || 'Cancel failed.');
    return;
  }
  await botReply(
    message,
    phone,
    [
      'Claim cancelled. Funds returned to your agent wallet.',
      result.claim ? `Was for +${result.claim.to_wa_hint} (${result.claim.amount_eth} ETH)` : null,
      result.explorerUrl || null,
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function runPayoutOneClaim(message, user, phone, account, claimId) {
  const siteAcc = await resolveLinkedSiteAccount(phone, account);
  if (!siteAcc?.id) {
    await botReply(
      message,
      phone,
      'Link WhatsApp to your Flizy account first to receive claims.\nflizy link CODE'
    );
    return;
  }
  await botReply(message, phone, 'Claiming funds...');
  const identity = await resolveClaimIdentity(message, phone);
  const result = await executeClaimPayout({
    claimId,
    toAccountId: siteAcc.id,
    toWaSender: phone,
    toWaPhone: identity.waPhone,
    provider,
    chain,
    escrowWallet,
  });
  if (!result.ok) {
    await botReply(message, phone, result.error || 'Claim failed.');
    return;
  }
  await botReply(
    message,
    phone,
    [
      'Claim received.',
      `${result.claim.amount_eth} ETH → your agent wallet`,
      result.explorerUrl || null,
      '',
      'Check: flizy balance',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function notifyIncomingClaimsAfterLink(message, phone, accountId) {
  try {
    const identity = await resolveClaimIdentity(message, phone);
    const claims = await listIncomingPending(identity);
    const requests = await listIncomingRequests(identity);
    const parts = [];
    if (claims.length) {
      const total = claims.reduce((s, c) => s + Number(c.amount_eth || 0), 0);
      parts.push(
        `${claims.length} pending claim(s) (~${formatEth(total)} ETH). Receive: flizy claim`
      );
    }
    if (requests.length) {
      parts.push(`${requests.length} payment request(s). Pay: flizy pay`);
    }
    if (!parts.length) return;
    await botReply(
      message,
      phone,
      ['After link, waiting for you:', ...parts.map((p) => `• ${p}`)].join('\n')
    );
  } catch (err) {
    console.warn('notifyIncomingClaimsAfterLink:', publicErrorMessage(err));
  }
}

/**
 * flizy request 0.01 from 234… | from john
 */
async function handleRequestMoney(message, user, phone, account, amountEth, fromRaw, isPhone) {
  const siteAcc = await requireLinkedSite(message, phone, account);
  if (!siteAcc) return;

  let amountNum;
  try {
    amountNum = Number(amountEth);
    ethers.parseEther(String(amountEth));
    if (!(amountNum > 0)) throw new Error('bad');
  } catch {
    await botReply(message, phone, 'Invalid amount.\nExample: flizy request 0.001 from 2348012345678');
    return;
  }
  if (amountNum > config.maxSendEth) {
    await botReply(message, phone, `Max per request is ${config.maxSendEth} ETH.`);
    return;
  }

  let fromWaHint = null;
  let fromLabel = null;

  if (isPhone) {
    fromWaHint = normalizeWaHint(fromRaw);
    if (!isPlausiblePhone(fromWaHint)) {
      await botReply(message, phone, 'Invalid phone. Use country code digits.');
      return;
    }
    if (fromWaHint === normalizeWaHint(phone)) {
      await botReply(message, phone, 'You cannot request money from your own number.');
      return;
    }
  } else {
    fromLabel = String(fromRaw).toLowerCase();
    // Best-effort: if trusted name exists, note it; still need a phone for WA delivery
    const resolved = await resolveSendTarget(phone, fromLabel, false, siteAcc.id);
    if (resolved.error) {
      await botReply(
        message,
        phone,
        [
          `Unknown name "${fromLabel}".`,
          'Request by WhatsApp number (best):',
          '  flizy request 0.001 from 2348012345678',
          'Or save a trusted name first, then use their phone number for requests.',
        ].join('\n')
      );
      return;
    }
    // Name-only without phone: store label; payer won't get WA notify unless we have phone
    await botReply(
      message,
      phone,
      [
        'Requests work best with a phone number so they see it after linking.',
        `Use: flizy request ${amountEth} from 234…`,
        '',
        `(Name "${fromLabel}" is saved as a label only if you use a number.)`,
      ].join('\n')
    );
    return;
  }

  try {
    const row = await createPaymentRequest({
      requesterAccountId: siteAcc.id,
      requesterWa: phone,
      fromWaHint,
      fromLabel,
      amountEth,
      chainId: chain.chainId,
    });
    await botReply(
      message,
      phone,
      [
        'Payment request created.',
        `Amount: ${amountEth} ETH`,
        `From: +${fromWaHint}`,
        '',
        'They see it only after that WhatsApp links Flizy, then:',
        '  flizy pay',
        '',
        'Cancel anytime: flizy requests',
        `Id: ${String(row.id).slice(0, 8)}…`,
      ].join('\n')
    );
  } catch (err) {
    console.error('createPaymentRequest:', publicErrorMessage(err));
    await botReply(message, phone, 'Could not create request. Try again.');
  }
}

async function handleRequestsCommand(message, user, phone, account, kind) {
  const siteAcc = await requireLinkedSite(message, phone, account);
  if (!siteAcc) return;

  if (kind === 'incoming') {
    let rows;
    try {
      const identity = await resolveClaimIdentity(message, phone);
      rows = await listIncomingRequests(identity);
    } catch (err) {
      console.error(publicErrorMessage(err));
      await botReply(message, phone, 'Could not load requests.');
      return;
    }
    if (!rows.length) {
      await botReply(message, phone, formatRequestsMenu([], 'incoming'));
      return;
    }
    if (rows.length === 1) {
      pendingClaimMenus.set(phone, {
        mode: 'pay_request',
        requests: rows,
        createdAt: Date.now(),
        awaitConfirmId: rows[0].id,
      });
      await botReply(
        message,
        phone,
        [
          'Pay this request?',
          `${rows[0].amount_eth} ETH`,
          '',
          'Reply: confirm',
          'Or: cancel',
        ].join('\n')
      );
      return;
    }
    pendingClaimMenus.set(phone, { mode: 'pay_request', requests: rows, createdAt: Date.now() });
    await botReply(message, phone, formatRequestsMenu(rows, 'incoming'));
    return;
  }

  // outgoing cancel
  let rows;
  try {
    rows = await listOutgoingRequests(siteAcc.id);
  } catch (err) {
    console.error(publicErrorMessage(err));
    await botReply(message, phone, 'Could not load requests.');
    return;
  }
  if (!rows.length) {
    await botReply(message, phone, formatRequestsMenu([], 'outgoing'));
    return;
  }
  if (rows.length === 1) {
    pendingClaimMenus.set(phone, {
      mode: 'cancel_request',
      requests: rows,
      createdAt: Date.now(),
      awaitConfirmId: rows[0].id,
    });
    await botReply(
      message,
      phone,
      [
        'Cancel this request?',
        `${rows[0].amount_eth} ETH from +${rows[0].from_wa_hint || '?'}`,
        '',
        'Reply: confirm',
        'Or: cancel',
      ].join('\n')
    );
    return;
  }
  pendingClaimMenus.set(phone, { mode: 'cancel_request', requests: rows, createdAt: Date.now() });
  await botReply(message, phone, formatRequestsMenu(rows, 'outgoing'));
}

async function startPayRequest(message, user, phone, account, requestId) {
  const siteAcc = await requireLinkedSite(message, phone, account);
  if (!siteAcc) return;
  const req = await getPaymentRequestById(requestId);
  if (!req || req.status !== 'pending') {
    await botReply(message, phone, 'That request is no longer pending.');
    return;
  }
  const identity = await resolveClaimIdentity(message, phone);
  const keys = claimMatchKeys(identity);
  const reqHint = normalizeWaHint(req.from_wa_hint);
  if (!keys.length || !keys.includes(reqHint)) {
    await botReply(
      message,
      phone,
      identity.waPhone
        ? 'This request is for a different WhatsApp number.'
        : 'Could not verify your phone for this request. Message the bot again, or re-link WhatsApp.'
    );
    return;
  }
  const requesterAcc = await ensureAgentWallet(req.requester_account_id);
  const toAddress = requesterAcc.agent_wallet_address;
  if (!toAddress) {
    await botReply(message, phone, 'Requester has no agent wallet yet.');
    return;
  }
  await handleSendResolved(
    message,
    user,
    phone,
    String(req.amount_eth),
    { address: ethers.getAddress(toAddress), label: 'request' },
    siteAcc,
    { skipTrusted: true, paymentRequestId: req.id }
  );
}

async function runCancelOneRequest(message, phone, account, requestId) {
  const siteAcc = await resolveLinkedSiteAccount(phone, account);
  if (!siteAcc?.id) {
    await botReply(message, phone, 'Link your site account first.');
    return;
  }
  const result = await cancelPaymentRequest(requestId, siteAcc.id);
  if (!result.ok) {
    await botReply(message, phone, 'Could not cancel (already paid or not yours).');
    return;
  }
  await botReply(message, phone, 'Request cancelled.');
}

async function handleLink(message, phone, code) {
  try {
    const waPhone = await extractPhoneFromWaMessage(message);
    const result = await consumeLinkCode(phone, code, waPhone);
    if (!result.ok) {
      if (result.reason === 'expired') {
        await message.reply('That link code expired. Generate a new one on the Flizy site.');
        return;
      }
      if (result.reason === 'already_linked_other') {
        await message.reply('This WhatsApp is already linked to a different Flizy account.');
        return;
      }
      await message.reply('Invalid link code. Open the Flizy site and generate a fresh link.');
      return;
    }
    const acc = result.account?.id
      ? await ensureAgentWallet(result.account.id)
      : result.account;
    await botReply(
      message,
      phone,
      [
        'WhatsApp connected to Flizy.',
        '',
        'Your Flizy account',
        acc?.email ? `Email: ${acc.email}` : null,
        acc?.display_name ? `Name: ${acc.display_name}` : null,
        `Agent wallet: ${acc?.agent_wallet_address || 'pending'}`,
        `WhatsApp id: ${phone}`,
        '',
        'Commands',
        '  flizy me',
        '  flizy balance',
        '  flizy add wallet 0x...',
        '  flizy send 0.0001 to john',
        '  confirm',
        '',
        'Reply with flizy me to confirm.',
      ]
        .filter(Boolean)
        .join('\n')
    );
    if (acc?.id) await notifyIncomingClaimsAfterLink(message, phone, acc.id);
  } catch (err) {
    console.error('link error:', publicErrorMessage(err));
    await message.reply('Could not link right now. Try a new code from the site.');
  }
}

async function handleSaveContact(message, user, phone, alias, address) {
  try {
    const saved = await saveContact(user, phone, alias, address);
    await message.reply(
      [
        'Contact saved.',
        `  ${saved.alias} → ${saved.address}`,
        '',
        `Now you can: send 0.001 to ${saved.alias}`,
        'List all: contacts',
      ].join('\n')
    );
  } catch (err) {
    await message.reply(`Could not save contact: ${err.message}`);
  }
}

async function handleRemoveContact(message, phone, alias) {
  try {
    const removed = await removeContact(phone, alias);
    if (!removed) {
      await message.reply(`No contact named "${alias}". Type contacts to list.`);
      return;
    }
    await message.reply(`Removed contact "${alias}".`);
  } catch (err) {
    await message.reply(`Could not remove contact: ${err.message}`);
  }
}

async function handleContactsList(message, phone) {
  try {
    const rows = await listContacts(phone);
    if (!rows.length) {
      await message.reply(
        'No contacts yet.\nSave one: save ama 0xYourAddressHere\nThen: send 0.001 to ama'
      );
      return;
    }
    const lines = ['Your contacts:'];
    for (const row of rows) {
      lines.push(`  ${row.alias} → ${row.address}`);
    }
    lines.push('', 'Send: send 0.001 to ' + rows[0].alias);
    await message.reply(lines.join('\n'));
  } catch (err) {
    await message.reply(`Could not list contacts: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// WhatsApp client
// ---------------------------------------------------------------------------

function resolveChromeExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

const chromeExecutable = resolveChromeExecutable();
if (chromeExecutable) {
  console.log(`Using browser: ${chromeExecutable}`);
} else {
  console.warn(
    'No system Chrome/Edge found. Install Chrome or run: npx.cmd puppeteer browsers install chrome'
  );
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: chromeExecutable,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  },
});

client.on('qr', (qr) => {
  console.log('Scan this QR with WhatsApp (Linked devices):');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('WhatsApp authenticated.');
});

client.on('auth_failure', (msg) => {
  console.error('WhatsApp auth failure:', msg);
});

client.on('ready', async () => {
  botWhatsAppNumber =
    process.env.BOT_WHATSAPP_NUMBER ||
    client.info?.wid?.user ||
    client.info?.me?.user ||
    botWhatsAppNumber;

  console.log('Flizy bot is ready!');
  console.log('');
  console.log('=== Multi-user model ===');
  console.log(`  Bot WhatsApp (one account for everyone): +${botWhatsAppNumber}`);
  console.log('  Friends must message THAT number (via site Dashboard → Open WhatsApp).');
  console.log('  Message yourself is ONLY for you testing on the bot phone.');
  console.log('  Each user is identified by their own WhatsApp id (not the bot number).');
  console.log('  Watch for [msg] fromMe=false when a friend messages you.');
  console.log('');
  if (ADMIN_PHONES.size === 0) {
    console.warn('Tip: claimadmin <secret> in WhatsApp if you are not admin yet.');
  } else {
    console.log(`Admins: ${[...ADMIN_PHONES].join(', ')}`);
  }
  console.log(`Ops wallet (gas/infra): ${wallet.address}`);
  console.log(`Claim escrow:           ${escrowWallet.address}`);
  console.log(`Explorer ops:           ${explorerAddressUrl(wallet.address)}`);
  console.log(`Explorer escrow:        ${explorerAddressUrl(escrowWallet.address)}`);
  try {
    const bal = await getBotBalanceEth();
    console.log(`Ops ETH:    ${bal}`);
  } catch (err) {
    console.warn('Could not fetch balance at startup:', err.message);
  }
});

function peerPhone(message) {
  const raw = message.fromMe ? message.to || message.from : message.from;
  return normalizePhone(raw);
}

function isBlockedChatId(chatId) {
  const id = String(chatId || '');
  if (!id) return true;
  if (id.includes('@g.us')) return true;
  if (id.includes('status@broadcast')) return true;
  if (id.includes('@newsletter')) return true;
  if (id.includes('@broadcast')) return true;
  return false;
}

/**
 * Allow:
 *  - Anyone messaging the bot number (fromMe=false) — this is how friends use Flizy
 *  - Message yourself only when operator tests on the same phone (fromMe=true)
 * Block groups, status, newsletters, and fromMe in other contacts' chats.
 *
 * getChat() often throws a bare "n" on current WhatsApp Web / LID chats — never
 * require it for allow/deny of inbound friends, and allow self-chat without it.
 */
async function isAllowedBotChat(message) {
  const chatId = message.fromMe ? message.to || message.from : message.from;
  if (isBlockedChatId(chatId)) {
    console.log(`[skip] blocked chat id ${chatId}`);
    return false;
  }

  // Friends / other phones messaging the bot — do not call getChat first
  if (!message.fromMe) {
    if (String(chatId || '').includes('@g.us')) {
      console.log(`[skip] group chat id ${chatId}`);
      return false;
    }
    return true;
  }

  // fromMe: operator Message yourself only (never reply into other people's chats)
  const botUser = normalizePhone(client.info?.wid?.user || botWhatsAppNumber || '');
  const peer = peerPhone(message);
  const idStr = String(chatId || '');
  const fromN = normalizePhone(message.from);
  const toN = normalizePhone(message.to);

  // Classic Message yourself: from and to are the same account
  if (fromN && toN && fromN === toN) {
    return true;
  }

  const isSelfById =
    (botUser && peer === botUser) ||
    (botUser && idStr.includes(botUser)) ||
    (botUser && fromN === botUser) ||
    (botUser && toN === botUser);

  if (isSelfById) {
    return true;
  }

  try {
    const chat = await message.getChat();
    if (chat.isGroup) {
      console.log(`[skip] group chat`);
      return false;
    }
    const title = `${chat.name || ''} ${chat.formattedTitle || ''}`.toLowerCase();
    const serialized = String(chat.id?._serialized || chat.id || '');
    const isSelfByName =
      title.includes('yourself') ||
      title.includes('(you)') ||
      title.includes('message yourself') ||
      /\byou\b/.test(title);
    const isSelfBySerialized = botUser && serialized.includes(botUser);

    if (isSelfByName || isSelfBySerialized) {
      return true;
    }

    console.log(
      `[skip] fromMe outside Message yourself title=${JSON.stringify(chat.name)} peer=${peer}`
    );
    return false;
  } catch (err) {
    // getChat broken: still allow Message yourself if peer looks like our bot line
    console.warn('getChat failed (fromMe):', err && err.message ? err.message : err);
    if (botUser && peer && (peer === botUser || idStr.includes(botUser))) {
      return true;
    }
    // Last resort for operator testing on linked device: allow short self-chat peers
    // only when BOT_ALLOW_SELF_ON_GETCHAT_FAIL=1
    if (process.env.BOT_ALLOW_SELF_ON_GETCHAT_FAIL === '1') {
      console.warn('[allow] fromMe self fallback (BOT_ALLOW_SELF_ON_GETCHAT_FAIL=1) peer=', peer);
      return true;
    }
    console.log(`[skip] fromMe getChat failed and peer not bot peer=${peer} chatId=${idStr}`);
    return false;
  }
}

async function handleIncomingMessage(message) {
  try {
    if (!message.body) return;

    const rawText = message.body.trim();
    if (!rawText) return;

    const allowed = await isAllowedBotChat(message);
    if (!allowed) return;

    const phone = peerPhone(message);
    if (!phone || phone === 'status' || phone.length < 6) return;

    if (phone.startsWith('120363') && String(message.from || '').includes('@g.us')) {
      return;
    }

    // Message yourself: bot replies are also fromMe — never treat them as user input
    if (isBotEcho(phone, rawText, message.fromMe)) {
      console.log(`[skip] bot echo phone=${phone}`);
      return;
    }

    pruneExpiredPending();

    const waitingForWalletName = pendingWalletAdds.has(phone);
    const waitingForClaimMenu = pendingClaimMenus.has(phone);
    const waitingForUnlock = pendingUnlocks.has(phone);

    // Ignore non-commands unless mid-flow (wallet name, claim menu, unlock password)
    if (
      !isFlizyCommand(rawText) &&
      !waitingForWalletName &&
      !waitingForClaimMenu &&
      !waitingForUnlock
    ) {
      return;
    }

    let text;
    if (isConfirmCommand(rawText) || isCancelCommand(rawText)) {
      text = rawText.trim().toLowerCase();
    } else if (
      waitingForClaimMenu &&
      !/^flizy\b/i.test(rawText) &&
      (/^\d+$/.test(rawText.trim()) || /^all$/i.test(rawText.trim()))
    ) {
      text = rawText.trim().toLowerCase();
    } else if (waitingForWalletName && !/^flizy\b/i.test(rawText)) {
      // bare name reply (e.g. john)
      text = rawText.trim();
    } else {
      const stripped = stripFlizyPrefix(rawText, { requirePrefix: config.requireFlizyPrefix });
      if (!stripped.ok) {
        if (waitingForWalletName || waitingForClaimMenu) {
          text = rawText.trim();
        } else {
          return;
        }
      } else {
        text = stripped.body === '' ? 'help' : stripped.body;
      }
    }

    console.log(
      `[msg] fromMe=${Boolean(message.fromMe)} phone=${phone} body=${JSON.stringify(rawText.slice(0, 120))}${
        message.fromMe ? ' (Message yourself / outbound)' : ' (friend or inbound to bot number)'
      }`
    );

    // Finish "flizy add wallet" name step (bare reply like "john" is allowed)
    if (pendingWalletAdds.has(phone)) {
      const pendingAdd = pendingWalletAdds.get(phone);
      const nameCandidate = text;

      if (isCancelCommand(nameCandidate)) {
        pendingWalletAdds.delete(phone);
        await botReply(message, phone, 'Cancelled.');
        return;
      }

      // Never treat our own prompt text as a label
      const lower = nameCandidate.trim().toLowerCase();
      if (
        lower === 'name' ||
        lower.startsWith('send a name for this wallet') ||
        lower.startsWith('added ') ||
        lower.startsWith('type your own label')
      ) {
        console.log(`[skip] ignore prompt-like name phone=${phone}`);
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
          await botReply(
            message,
            phone,
            'Name must start with a letter (a-z), then letters/numbers/_ only.\nExample: john\nOr: cancel'
          );
          return;
        }
        try {
          const bridged = await getOrCreateAccountForSender(phone);
          const account = await ensureAgentWallet(bridged.account.id);
          await getOrCreateUser(phone);
          await addTrusted(account.id, pendingAdd.address, chosen.toLowerCase());
          pendingWalletAdds.delete(phone);
          await botReply(message, phone, `added ${chosen.toLowerCase()} \u2705`);
        } catch (err) {
          console.error('add wallet name step:', publicErrorMessage(err));
          pendingWalletAdds.delete(phone);
          await botReply(message, phone, 'Could not add wallet. Try again.');
        }
        return;
      }
      // fall through to process the new command; clear stale name wait
      pendingWalletAdds.delete(phone);
    }

    // Link FIRST (before auto-creating a competing account for this WhatsApp id)
    const earlyLink = parseLinkCommand(text);
    if (earlyLink) {
      try {
        const waPhone = await extractPhoneFromWaMessage(message);
        console.log(
          `[link] attempt sender=${maskPhone(phone)} phone=${waPhone ? maskPhone(waPhone) : 'none'} code=${earlyLink.code}`
        );
        const result = await consumeLinkCode(phone, earlyLink.code, waPhone);
        if (!result.ok) {
          if (result.reason === 'expired') {
            await botReply(
              message,
              phone,
              'That link code expired. Generate a new one on the Flizy site.'
            );
            return;
          }
          await botReply(
            message,
            phone,
            'Invalid link code. Open the Flizy site and generate a fresh link.'
          );
          return;
        }
        // Ensure legacy users row + agent wallet on the site account
        await getOrCreateUser(phone);
        const acc = await ensureAgentWallet(result.account.id);
        // Sync ledger credit onto users row for send checks
        await supabase
          .from('users')
          .update({
            account_id: acc.id,
            balance_eth: acc.balance_eth ?? 0,
            is_admin: Boolean(acc.is_admin),
            wallet_address: acc.agent_wallet_address,
          })
          .eq('phone', phone);

        console.log(
          `[link] ok sender=${maskPhone(phone)} phone=${waPhone ? maskPhone(waPhone) : 'none'} account=${acc.id} wallet=${acc.agent_wallet_address}`
        );
        await botReply(
          message,
          phone,
          [
            'WhatsApp connected to Flizy.',
            '',
            'Your Flizy account',
            acc.email ? `Email: ${acc.email}` : null,
            acc.display_name ? `Name: ${acc.display_name}` : null,
            `Agent wallet: ${acc.agent_wallet_address || 'pending'}`,
            `WhatsApp id: ${phone}`,
            '',
            'Commands',
            '  flizy me',
            '  flizy balance',
            '  flizy add wallet 0x...',
            '  flizy send 0.0001 to john',
            '  confirm',
            '',
            'Reply with flizy me to confirm.',
          ]
            .filter(Boolean)
            .join('\n')
        );
        if (acc?.id) await notifyIncomingClaimsAfterLink(message, phone, acc.id);
      } catch (err) {
        console.error('link error:', publicErrorMessage(err));
        await botReply(message, phone, 'Could not link right now. Try a new code from the site.');
      }
      return;
    }

    let user;
    let isNew = false;
    let account = null;
    try {
      const result = await getOrCreateUser(phone);
      user = result.user;
      isNew = result.isNew;
      const bridged = await getOrCreateAccountForSender(phone);
      account = bridged.account;
    } catch (err) {
      console.error('user upsert error:', publicErrorMessage(err));
      await message.reply('Database error registering your number. Try again shortly.');
      return;
    }

    // Interactive unlock password reply (plain text, or flizy unlock SECRET)
    if (pendingUnlocks.has(phone)) {
      const wait = pendingUnlocks.get(phone);
      if (Date.now() - wait.createdAt > PENDING_TTL_MS) {
        pendingUnlocks.delete(phone);
        await botReply(message, phone, 'Unlock timed out. Send: flizy unlock');
        return;
      }
      const unlockAgain = parseUnlockCommand(text);
      if (unlockAgain && unlockAgain.pin == null) {
        await botReply(
          message,
          phone,
          'Reply with your account password or unlock PIN.\n(Send only the secret as the next message.)'
        );
        return;
      }
      const secret =
        unlockAgain && unlockAgain.pin != null ? unlockAgain.pin : String(rawText || '').trim();
      pendingUnlocks.delete(phone);
      const res = await unlockWithPin(account, phone, secret);
      if (!res.ok && res.reason === 'no_pin') {
        await botReply(
          message,
          phone,
          `No password or PIN on this account.\nSet a PIN on the site: ${config.siteUrl}/dashboard/account`
        );
        return;
      }
      if (!res.ok) {
        await botReply(message, phone, 'Unlock failed. Wrong password or PIN.\nTry: flizy unlock');
        return;
      }
      await botReply(
        message,
        phone,
        'Session unlocked.\nCommands work again for about 1 hour of activity.\nLock anytime: flizy lock'
      );
      return;
    }

    // Unlock: prompt or one-shot secret
    const unlockCmd = parseUnlockCommand(text);
    if (unlockCmd) {
      if (unlockCmd.pin == null || unlockCmd.pin === '') {
        pendingUnlocks.set(phone, { createdAt: Date.now() });
        await botReply(
          message,
          phone,
          [
            'Unlock Flizy on this WhatsApp.',
            'Reply with your account password or unlock PIN.',
            '(Send only the password as the next message.)',
          ].join('\n')
        );
        return;
      }
      const res = await unlockWithPin(account, phone, unlockCmd.pin);
      if (!res.ok && res.reason === 'no_pin') {
        await botReply(
          message,
          phone,
          `No password or PIN on this account.\nSet a PIN on the site: ${config.siteUrl}/dashboard/account`
        );
        return;
      }
      if (!res.ok) {
        await botReply(message, phone, 'Unlock failed. Wrong password or PIN.');
        return;
      }
      await botReply(
        message,
        phone,
        'Session unlocked.\nCommands work again for about 1 hour of activity.\nLock anytime: flizy lock'
      );
      return;
    }

    // Lock (no password)
    if (parseLockCommand(text)) {
      pendingUnlocks.delete(phone);
      await lockSession(account.id, phone);
      await botReply(
        message,
        phone,
        [
          'Session locked.',
          'Other flizy commands will not run until you unlock.',
          'Unlock: flizy unlock',
          'Then reply with your password or PIN when asked.',
        ].join('\n')
      );
      return;
    }

    // Hard lock gate: after flizy lock (or expired unlock session), only unlock/link allowed
    if (!isAdminUser(user)) {
      const hardLocked = await isSessionHardLocked(account.id, phone);
      if (hardLocked && !isAllowedWhenLocked(text)) {
        await botReply(
          message,
          phone,
          'Session locked.\nSend: flizy unlock\nThen reply with your password or PIN.'
        );
        return;
      }
      try {
        const { getSession } = require('./lib/session');
        const row = await getSession(account.id, phone);
        if (row && !row.is_locked && new Date(row.expires_at).getTime() > Date.now()) {
          await touchSession(account.id, phone);
        }
      } catch {
        /* ignore */
      }
    }

    if (isNew) {
      await message.reply(welcomeText(user));
      if (isHelpCommand(text) || isHowCommand(text)) return;
    }

    if (isHelpCommand(text)) {
      await handleHelp(message, user);
      return;
    }

    if (isHowCommand(text)) {
      await handleHow(message);
      return;
    }

    if (isMeCommand(text)) {
      await handleMe(message, user, account);
      return;
    }

    if (isDepositCommand(text)) {
      await handleDeposit(message, user, account);
      return;
    }

    if (isBalanceCommand(text)) {
      await handleBalance(message, user, account);
      return;
    }

    if (isHistoryCommand(text)) {
      await handleHistory(message, phone);
      return;
    }

    if (isContactsListCommand(text)) {
      await handleContactsList(message, phone);
      return;
    }

    if (isPoolCommand(text)) {
      await handlePool(message, user);
      return;
    }

    if (isEscrowCommand(text)) {
      await handleEscrow(message, user);
      return;
    }

    if (isUsersCommand(text)) {
      await handleUsers(message, user);
      return;
    }

    const addWalletCmd = parseAddWalletCommand(text);
    if (addWalletCmd) {
      if (!ethers.isAddress(addWalletCmd.address)) {
        await message.reply('Invalid address. Use a full 0x wallet address.');
        return;
      }
      const checksum = ethers.getAddress(addWalletCmd.address);
      pendingSends.delete(phone);
      pendingWalletAdds.set(phone, { address: checksum, createdAt: Date.now() });
      // Prompt the USER for a label. Do not use a one-word reply like "name"
      // (in Message yourself that echo was treated as the label).
      await botReply(
        message,
        phone,
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
      await handleSaveContact(message, user, phone, saveCmd.alias, saveCmd.address);
      return;
    }

    const removeCmd = parseRemoveContactCommand(text);
    if (removeCmd) {
      await handleRemoveContact(message, phone, removeCmd.alias);
      return;
    }

    const claim = parseClaimAdminCommand(text);
    if (claim) {
      await handleClaimAdmin(message, user, claim.secret);
      return;
    }

    const creditCmd = parseCreditCommand(text);
    if (creditCmd) {
      await handleCredit(message, user, creditCmd.phone, creditCmd.amountEth);
      return;
    }

    // Claim cancel/receive menus (1, 2, All, confirm)
    if (pendingClaimMenus.has(phone)) {
      const handledMenu = await handleClaimMenuReply(message, user, phone, account, text);
      if (handledMenu) return;
    }

    const cancelClaims = parseCancelClaimsCommand(text);
    if (cancelClaims) {
      await handleCancelClaims(message, user, phone, account, cancelClaims.filter);
      return;
    }

    const claimsList = parseClaimsListCommand(text);
    if (claimsList) {
      await handleClaimsList(message, user, phone, account, claimsList.kind);
      return;
    }

    const reqCmd = parseRequestCommand(text);
    if (reqCmd) {
      await handleRequestMoney(
        message,
        user,
        phone,
        account,
        reqCmd.amountEth,
        reqCmd.fromRaw,
        reqCmd.isPhone
      );
      return;
    }

    const requestsCmd = parseRequestsCommand(text);
    if (requestsCmd) {
      await handleRequestsCommand(message, user, phone, account, requestsCmd.kind);
      return;
    }

    if (isCancelCommand(text)) {
      await handleCancel(message, phone);
      return;
    }

    if (isConfirmCommand(text)) {
      // Single-claim confirm menus handled above; else transfer plan confirm
      if (pendingClaimMenus.has(phone)) {
        await handleClaimMenuReply(message, user, phone, account, text);
        return;
      }
      await handleConfirm(message, user, phone);
      return;
    }

    const swapCmd = parseSwapCommand(text);
    if (swapCmd) {
      await handleSwapCommand(message, user, phone, account, swapCmd);
      return;
    }

    const send = parseSendCommand(text);
    if (send) {
      await handleSend(
        message,
        user,
        phone,
        send.amountEth,
        send.toRaw,
        send.isAddress,
        send.isPhone,
        account
      );
      return;
    }
  } catch (err) {
    console.error('message handler error:', publicErrorMessage(err));
    try {
      await message.reply('Something went wrong. Please try again.');
    } catch {
      // ignore
    }
  }
}

/** Dedupe message / message_create double-fires */
const seenMessageIds = new Set();
function alreadyHandled(message) {
  const id =
    (message.id && message.id._serialized) ||
    (message.id && message.id.id) ||
    null;
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 800) {
    seenMessageIds.clear();
  }
  return false;
}

// Inbound from friends (and some self events)
client.on('message', (message) => {
  if (alreadyHandled(message)) return;
  handleIncomingMessage(message);
});

// message_create: catches Message yourself (fromMe) + some inbound that "message" misses
client.on('message_create', (message) => {
  if (alreadyHandled(message)) return;
  handleIncomingMessage(message);
});

client.initialize().catch((err) => {
  console.error('Failed to start WhatsApp client:', err);
  process.exit(1);
});
