const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { ethers } = require('ethers');
require('dotenv').config();

const { config, requireEnv } = require('./lib/config');
const { getDefaultChain, explorerTxUrl: chainTxUrl, explorerAddressUrl: chainAddressUrl } = require('./lib/chains');
const { getSupabase } = require('./lib/supabase');
const { insertTransfer, logSubmitted, logReceipt } = require('./lib/transferLog');
const { publicErrorMessage } = require('./lib/sanitize');
const {
  getOrCreateAccountForSender,
  getAccountByWaSender,
  consumeLinkCode,
} = require('./lib/identity');
const { stripFlizyPrefix, parseUnlockCommand, parseLockCommand } = require('./lib/prefix');
const { isSessionUnlocked, unlockWithPin, touchSession, lockSession } = require('./lib/session');
const { isTrustedAddress, rejectUntrustedMessage, addTrusted } = require('./lib/trusted');
const { createClaim } = require('./lib/claims');
const {
  ensureAgentWallet,
  getAgentSigner,
  formatAccountWalletCard,
} = require('./lib/agentWallet');
const { getWalletHoldings, formatHoldingsMessage } = require('./lib/holdings');

// ---------------------------------------------------------------------------
// Config (Phase 0: chain registry + config-driven copy)
// ---------------------------------------------------------------------------

requireEnv(['SUPABASE_URL', 'SUPABASE_KEY', 'GIWA_RPC', 'PRIVATE_KEY']);

const chain = getDefaultChain();
const PENDING_TTL_MS = config.pendingTtlMs;
const MAX_SEND_ETH = config.maxSendEth;
const GAS_BUFFER_ETH = config.gasBufferEth;
const ADMIN_PHONES = config.adminPhones;
const REJECT_UNTRUSTED = config.rejectUntrustedCopy;

const supabase = getSupabase();
const provider = new ethers.JsonRpcProvider(chain.rpcUrl, chain.chainId);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

/** @type {Map<string, { amountEth: string, to: string, createdAt: number }>} */
const pendingSends = new Map();

/** @type {Map<string, { address: string, createdAt: number }>} */
const pendingWalletAdds = new Map();

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
 * Reply and remember body so fromMe echo is not treated as user input.
 * Prefer reply(); fall back to chat.sendMessage for some new contacts.
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
    console.warn('message.reply failed, using chat.sendMessage:', err.message);
    const chat = await message.getChat();
    return chat.sendMessage(body);
  }
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

function normalizePhone(from) {
  return String(from || '')
    .split('@')[0]
    .trim()
    .replace(/^\+/, '')
    .replace(/\D/g, '');
}

function formatEth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (n === 0) return '0';
  if (n < 0.000001) return n.toExponential(4);
  return n.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * send 0.01 to 0x...  |  send 0.01 to ama
 * @returns {{ amountEth: string, toRaw: string, isAddress: boolean } | null}
 */
function parseSendCommand(text) {
  const addr = text.match(
    /send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+(0x[a-fA-F0-9]{40})\b/i
  );
  if (addr) {
    return { amountEth: addr[1], toRaw: addr[2], isAddress: true };
  }
  const alias = text.match(
    /send\s+([0-9]*\.?[0-9]+)\s*(?:eth)?\s+to\s+([a-zA-Z][a-zA-Z0-9_]{0,31})\b/i
  );
  if (alias) {
    return { amountEth: alias[1], toRaw: alias[2], isAddress: false };
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
    isUsersCommand(t) ||
    isContactsListCommand(t) ||
    isConfirmCommand(t) ||
    isCancelCommand(t) ||
    Boolean(parseSendCommand(t)) ||
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

/** Actions that do not need unlock session. */
function isPublicCommandBody(body) {
  return (
    isHelpCommand(body) ||
    isHowCommand(body) ||
    isMeCommand(body) ||
    Boolean(parseLinkCommand(body)) ||
    Boolean(parseUnlockCommand(body)) ||
    Boolean(parseClaimAdminCommand(body))
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

async function recordTransfer(row) {
  return insertTransfer({
    ...row,
    chain_id: chain.chainId,
    kind: row.kind || 'transfer',
  });
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
    '  confirm',
    '  cancel',
    '',
    'Add wallet from chat:',
    '  flizy add wallet 0xYourAddress',
    '  (bot asks for a name)',
    '  john',
    '  -> added',
    '',
    'Setup:',
    '  1) Create account on the site (optional but recommended)',
    '  2) flizy link CODE  or  flizy add wallet ...',
    '  3) flizy send 0.0001 to john',
    '',
    `Site: ${config.siteUrl}`,
    `Chain: ${chain.name} (${chain.chainId})`,
    '',
    'Testnet. Confirmed sends are irreversible.',
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
    '  flizy unlock <pin>   (PIN set on site)',
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
        'Hot wallet pool (on-chain)',
        `${formatEth(pool)} ETH`,
        wallet.address,
        explorerAddressUrl(wallet.address),
      ].join('\n')
    );
  } catch (err) {
    console.error('pool error:', err);
    await message.reply('Could not read pool balance.');
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

async function handleSend(message, user, phone, amountEth, toRaw, isAddress, account) {
  // Always spend from the permanent site-linked agent wallet (not a bot-only orphan).
  const siteAcc = await resolveLinkedSiteAccount(phone, account);
  if (!siteAcc?.id) {
    await message.reply(
      `Link your site account first.\nOpen ${config.siteUrl}/dashboard and send flizy link CODE`
    );
    return;
  }

  const resolved = await resolveSendTarget(phone, toRaw, isAddress, siteAcc.id);
  if (resolved.error) {
    await message.reply(resolved.error);
    return;
  }
  const checksumTo = resolved.address;
  const label = resolved.label;

  // Trusted allowlist (site or flizy add wallet)
  if (config.enforceTrusted) {
    const ok = await isTrustedAddress(siteAcc.id, checksumTo);
    if (!ok) {
      await message.reply(rejectUntrustedMessage());
      return;
    }
  }

  let amountWei;
  try {
    amountWei = ethers.parseEther(amountEth);
  } catch {
    await message.reply('Invalid amount. Example: flizy send 0.01 to john');
    return;
  }

  if (amountWei <= 0n) {
    await message.reply('Amount must be greater than 0.');
    return;
  }

  if (Number(amountEth) > MAX_SEND_ETH) {
    await message.reply(`Max per send is ${MAX_SEND_ETH} ETH.`);
    return;
  }

  const admin = isAdminUser(user);
  const credit = Number(user.balance_eth || 0);

  if (config.enforceCredit && !admin && credit < Number(amountEth)) {
    await message.reply(
      [
        'Not enough spendable credit.',
        `You have ${formatEth(credit)} ETH credit.`,
        `Need ${formatEth(amountEth)} ETH.`,
        '',
        'Send: flizy deposit',
      ].join('\n')
    );
    return;
  }

  let fromAddress;
  try {
    const acc = await ensureAgentWallet(siteAcc.id);
    fromAddress = ethers.getAddress(acc.agent_wallet_address);
    const balanceWei = await provider.getBalance(fromAddress);
    const gasBuffer = ethers.parseEther(GAS_BUFFER_ETH);
    if (balanceWei < amountWei + gasBuffer) {
      const bal = ethers.formatEther(balanceWei);
      await message.reply(
        [
          'Not enough ETH in your agent wallet (amount + gas).',
          `Have ${formatEth(bal)} ETH`,
          `Need ~${amountEth} ETH + gas`,
          `Fund: ${fromAddress}`,
          explorerAddressUrl(fromAddress),
        ].join('\n')
      );
      return;
    }
  } catch (err) {
    console.error('agent balance check failed:', publicErrorMessage(err));
    await message.reply('Could not check your agent wallet on GIWA. Try again shortly.');
    return;
  }

  pendingSends.set(phone, {
    amountEth,
    to: checksumTo,
    fromAccountId: siteAcc.id,
    fromAddress,
    createdAt: Date.now(),
  });

  const toDisplay = label
    ? `${label} (${shortAddress(checksumTo)})`
    : shortAddress(checksumTo);
  const lines = [
    'Pending transfer',
    `  Amount: ${amountEth} ETH`,
    `  To: ${toDisplay}`,
    `  From: ${shortAddress(fromAddress)} (your agent wallet)`,
    '',
    'Reply confirm (or flizy confirm) within 5 minutes.',
    'Or: cancel',
  ];
  await message.reply(lines.join('\n'));
}

async function handleConfirm(message, user, phone) {
  pruneExpiredPending();
  const pending = pendingSends.get(phone);

  if (!pending) {
    // No pending: stay silent (do not spam "start with send...")
    return;
  }

  if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
    pendingSends.delete(phone);
    await message.reply('Pending transfer expired. Start again with send ...');
    return;
  }

  pendingSends.delete(phone);

  const { amountEth, to, fromAccountId } = pending;
  let amountWei;
  try {
    amountWei = ethers.parseEther(amountEth);
  } catch {
    await message.reply('Pending amount was invalid. Start again.');
    return;
  }

  let fresh = user;
  try {
    const res = await getOrCreateUser(phone);
    fresh = res.user;
  } catch (err) {
    console.error('confirm re-fetch user:', err);
  }

  const admin = isAdminUser(fresh);
  const credit = Number(fresh.balance_eth || 0);
  const amountNum = Number(amountEth);

  if (config.enforceCredit && !admin && credit < amountNum) {
    await message.reply('Not enough credit to complete. Send flizy deposit for options.');
    return;
  }

  let accountIdForTx = fromAccountId || null;
  if (!accountIdForTx) {
    try {
      const bridged = await getOrCreateAccountForSender(phone);
      accountIdForTx = bridged.account?.id || null;
    } catch {
      // optional
    }
  }

  if (!accountIdForTx) {
    await message.reply('No agent wallet linked. Open the site and flizy link CODE first.');
    return;
  }

  const transferRow = await recordTransfer({
    user_id: fresh.id,
    account_id: accountIdForTx,
    phone,
    to_address: to,
    amount_eth: amountEth,
    status: 'pending',
  });

  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== chain.chainId) {
      throw new Error(`Wrong chain id ${network.chainId}, expected ${chain.chainId}`);
    }

    // Always send from the user's site agent wallet (not the bot ops key)
    await ensureAgentWallet(accountIdForTx);
    const agentSigner = getAgentSigner(accountIdForTx, provider);

    const balanceWei = await provider.getBalance(agentSigner.address);
    const gasBuffer = ethers.parseEther(GAS_BUFFER_ETH);
    if (balanceWei < amountWei + gasBuffer) {
      await message.reply(
        [
          'Not enough ETH in your agent wallet.',
          `Fund: ${agentSigner.address}`,
          explorerAddressUrl(agentSigner.address),
        ].join('\n')
      );
      return;
    }

    const tx = await agentSigner.sendTransaction({
      to,
      value: amountWei,
    });

    await logSubmitted(transferRow?.id, tx.hash);

    const receipt = await tx.wait(1);
    const ok = Boolean(receipt && receipt.status === 1);
    const link = explorerTxUrl(tx.hash);

    if (ok && config.enforceCredit && credit >= amountNum) {
      await setUserBalance(fresh.id, credit - amountNum);
      try {
        await supabase
          .from('accounts')
          .update({ balance_eth: credit - amountNum })
          .eq('id', accountIdForTx);
      } catch {
        // non-fatal
      }
    }

    await logReceipt(transferRow?.id, {
      ok,
      txHash: tx.hash,
      error: ok ? null : 'receipt status not successful',
    });

    if (!transferRow?.id) {
      await insertTransfer({
        user_id: fresh.id,
        account_id: accountIdForTx,
        phone,
        to_address: to,
        amount_eth: amountEth,
        status: ok ? 'confirmed' : 'failed',
        tx_hash: tx.hash,
        chain_id: chain.chainId,
        kind: 'transfer',
        error: ok ? null : 'receipt status not successful',
      });
    }

    await message.reply(link);
  } catch (err) {
    console.error('send tx error:', publicErrorMessage(err));
    const reason = publicErrorMessage(err);
    if (transferRow?.id) {
      await logReceipt(transferRow.id, { ok: false, txHash: '', error: reason });
    }
    await message.reply('Failed.');
  }
}

async function handleCancel(message, phone) {
  if (pendingSends.has(phone)) {
    pendingSends.delete(phone);
    await message.reply('Pending transfer cancelled. Credit unchanged.');
    return true;
  }
  // No pending: stay silent so random "cancel" does not look like a bot chat
  return false;
}

async function handleLink(message, phone, code) {
  try {
    const result = await consumeLinkCode(phone, code);
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
  console.log(`Bot wallet: ${wallet.address}`);
  console.log(`Explorer:   ${explorerAddressUrl(wallet.address)}`);
  try {
    const bal = await getBotBalanceEth();
    console.log(`Pool ETH:   ${bal}`);
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
 */
async function isAllowedBotChat(message) {
  const chatId = message.fromMe ? message.to || message.from : message.from;
  if (isBlockedChatId(chatId)) {
    console.log(`[skip] blocked chat id ${chatId}`);
    return false;
  }

  try {
    const chat = await message.getChat();
    if (chat.isGroup) {
      console.log(`[skip] group chat`);
      return false;
    }

    // Friends / other phones messaging the bot WhatsApp number
    if (!message.fromMe) {
      return true;
    }

    // Outgoing: only Message yourself (operator testing), never hijack normal chats
    const title = `${chat.name || ''} ${chat.formattedTitle || ''}`.toLowerCase();
    const botUser = normalizePhone(client.info?.wid?.user || botWhatsAppNumber || '');
    const peer = peerPhone(message);
    const serialized = String(chat.id?._serialized || chat.id || '');

    const isSelfByName =
      title.includes('yourself') ||
      title.includes('(you)') ||
      title.includes('message yourself') ||
      /\byou\b/.test(title);

    const isSelfById =
      (botUser && peer === botUser) || (botUser && serialized.includes(botUser));

    if (isSelfByName || isSelfById) {
      return true;
    }

    console.log(
      `[skip] fromMe outside Message yourself title=${JSON.stringify(chat.name)} peer=${peer}`
    );
    return false;
  } catch (err) {
    // If chat inspect fails: still allow inbound (friends); block ambiguous fromMe
    console.warn('getChat failed:', err.message);
    return !message.fromMe;
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

    // Ignore non-commands unless we are waiting for a trusted-wallet name
    if (!isFlizyCommand(rawText) && !waitingForWalletName) {
      return;
    }

    let text;
    if (isConfirmCommand(rawText) || isCancelCommand(rawText)) {
      text = rawText.trim().toLowerCase();
    } else if (waitingForWalletName && !/^flizy\b/i.test(rawText)) {
      // bare name reply (e.g. john)
      text = rawText.trim();
    } else {
      const stripped = stripFlizyPrefix(rawText, { requirePrefix: config.requireFlizyPrefix });
      if (!stripped.ok) {
        if (waitingForWalletName) {
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
        const result = await consumeLinkCode(phone, earlyLink.code);
        if (!result.ok) {
          if (result.reason === 'expired') {
            await message.reply('That link code expired. Generate a new one on the Flizy site.');
            return;
          }
          await message.reply('Invalid link code. Open the Flizy site and generate a fresh link.');
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
      } catch (err) {
        console.error('link error:', publicErrorMessage(err));
        await message.reply('Could not link right now. Try a new code from the site.');
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

    // Unlock / lock (public)
    const unlockCmd = parseUnlockCommand(text);
    if (unlockCmd) {
      const res = await unlockWithPin(account, phone, unlockCmd.pin);
      if (!res.ok && res.reason === 'no_pin') {
        await message.reply(`No unlock PIN set. Set it on the site: ${config.siteUrl}/dashboard`);
        return;
      }
      if (!res.ok) {
        await message.reply('Unlock failed.');
        return;
      }
      await message.reply('Session unlocked for 1 hour of activity.');
      return;
    }

    if (parseLockCommand(text)) {
      await lockSession(account.id, phone);
      await message.reply('Session locked.');
      return;
    }

    // Session gate for sensitive actions
    if (config.requireUnlock && !isPublicCommandBody(text) && !isAdminUser(user)) {
      const open = await isSessionUnlocked(account.id, phone);
      if (!open) {
        // If no PIN configured yet, allow but nudge once
        if (!account.unlock_pin_hash) {
          // allow through until PIN is set on site
        } else {
          await message.reply('Session locked. Send: flizy unlock <pin>');
          return;
        }
      } else {
        await touchSession(account.id, phone);
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

    if (isCancelCommand(text)) {
      await handleCancel(message, phone);
      return;
    }

    if (isConfirmCommand(text)) {
      await handleConfirm(message, user, phone);
      return;
    }

    const send = parseSendCommand(text);
    if (send) {
      await handleSend(message, user, phone, send.amountEth, send.toRaw, send.isAddress, account);
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
