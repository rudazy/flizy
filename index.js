/**
 * Flizy WhatsApp client.
 *
 * This file is an adapter, not the product. Everything WhatsApp specific lives
 * here: the web session, echo suppression, LID/phone extraction and chat rules.
 * The moment a message is understood as user input it goes to lib/router, which
 * is the same code path Telegram uses.
 */

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { config } = require('./lib/config');
const {
  chain,
  provider,
  opsWallet,
  escrowWallet,
  addressUrl,
  getOpsBalanceEth,
} = require('./lib/runtime');
const { publicErrorMessage } = require('./lib/sanitize');
const { CHANNELS } = require('./lib/identity');
const { normalizePhoneNumber, isPlausiblePhone } = require('./lib/phone');
const { registerChannelSender, startOutboxDrain } = require('./lib/notify');
const router = require('./lib/router');

const CHANNEL = CHANNELS.WHATSAPP;
const ADMIN_PHONES = config.adminPhones;

let botWhatsAppNumber = config.botWhatsAppNumber || '';

/**
 * Last bot outbound body per chat. Message yourself delivers our own replies
 * back as fromMe, so we must never read them as user input.
 * @type {Map<string, { body: string, at: number }>}
 */
const lastBotOutbound = new Map();

// ---------------------------------------------------------------------------
// WhatsApp helpers
// ---------------------------------------------------------------------------

/** Canonical sender digits (also the identity key for this channel). */
function peerPhone(message) {
  const raw = message.fromMe ? message.to || message.from : message.from;
  return normalizePhoneNumber(raw);
}

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
 * Reply and remember the body so our own echo is not treated as user input.
 * Prefer reply(); never depend only on getChat (it often throws "n" on WA Web).
 */
async function botReply(message, key, text) {
  const body = String(text);
  lastBotOutbound.set(key, { body: body.trim(), at: Date.now() });

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
    console.error('botReply all methods failed key=', key, 'chatId=', chatId, publicErrorMessage(err));
  }
  return null;
}

/** True if this fromMe message is the bot's own recent reply (echo). */
function isBotEcho(key, rawText, fromMe) {
  if (!fromMe) return false;
  const last = lastBotOutbound.get(key);
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

/**
 * Best-effort real phone from WhatsApp message context.
 * Prefers getContactLidAndPhone (pn alongside LID). Never invents a number.
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
 * Allow:
 *  - Anyone messaging the bot number (fromMe=false) — this is how friends use Flizy
 *  - Message yourself only when the operator tests on the same phone (fromMe=true)
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

  if (!message.fromMe) {
    if (String(chatId || '').includes('@g.us')) {
      console.log(`[skip] group chat id ${chatId}`);
      return false;
    }
    return true;
  }

  const botUser = normalizePhoneNumber(client.info?.wid?.user || botWhatsAppNumber || '');
  const peer = peerPhone(message);
  const idStr = String(chatId || '');
  const fromN = normalizePhoneNumber(message.from);
  const toN = normalizePhoneNumber(message.to);

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
      console.log('[skip] group chat');
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
    console.warn('getChat failed (fromMe):', err && err.message ? err.message : err);
    if (botUser && peer && (peer === botUser || idStr.includes(botUser))) {
      return true;
    }
    if (process.env.BOT_ALLOW_SELF_ON_GETCHAT_FAIL === '1') {
      console.warn('[allow] fromMe self fallback (BOT_ALLOW_SELF_ON_GETCHAT_FAIL=1) peer=', peer);
      return true;
    }
    console.log(`[skip] fromMe getChat failed and peer not bot peer=${peer} chatId=${idStr}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Router context
// ---------------------------------------------------------------------------

/**
 * @param {import('whatsapp-web.js').Message} message
 * @param {string} externalId observed sender id (often a LID)
 */
function buildCtx(message, externalId) {
  const key = `${CHANNEL}:${externalId}`;
  return {
    channel: CHANNEL,
    externalId,
    key,
    raw: message,
    reply: (text) => botReply(message, key, text),
    // WhatsApp exposes the real number through contact metadata, never typed input
    resolveVerifiedPhone: () => extractPhoneFromWaMessage(message),
  };
}

/**
 * Outbound for notifications (no inbound message to reply to).
 * @param {string} externalId
 * @param {string} body
 */
async function sendToIdentity(externalId, body) {
  const id = String(externalId || '').split('@')[0];
  if (!id) throw new Error('missing recipient id');
  const chatId = isPlausiblePhone(id) ? `${id}@c.us` : `${id}@lid`;
  if (isBlockedChatId(chatId)) throw new Error('blocked chat id');
  lastBotOutbound.set(`${CHANNEL}:${id}`, { body: String(body).trim(), at: Date.now() });
  return client.sendMessage(chatId, String(body));
}

// ---------------------------------------------------------------------------
// WhatsApp client
// ---------------------------------------------------------------------------

function resolveChromeExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = [
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES &&
      path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env['PROGRAMFILES(X86)'] &&
      path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
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

  // This process owns the WhatsApp session, so it delivers WhatsApp notifications
  registerChannelSender(CHANNEL, sendToIdentity);
  startOutboxDrain(CHANNEL);

  console.log('Flizy WhatsApp client is ready.');
  console.log('');
  console.log(`  Bot WhatsApp (one account for everyone): +${botWhatsAppNumber}`);
  console.log('  Friends must message THAT number (via site Dashboard).');
  console.log('  Each user is identified by their own WhatsApp id (not the bot number).');
  console.log('');
  if (ADMIN_PHONES.size === 0) {
    console.warn('Tip: claimadmin <secret> in WhatsApp if you are not admin yet.');
  } else {
    console.log(`Admins: ${[...ADMIN_PHONES].join(', ')}`);
  }
  console.log(`Chain:                  ${chain.name} (${chain.chainId})`);
  console.log(`Ops wallet (gas/infra): ${opsWallet.address}`);
  console.log(`Claim escrow:           ${escrowWallet.address}`);
  console.log(`Explorer ops:           ${addressUrl(opsWallet.address)}`);
  try {
    const bal = await getOpsBalanceEth();
    console.log(`Ops ETH:                ${bal}`);
  } catch (err) {
    console.warn('Could not fetch balance at startup:', err.message);
  }
});

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

async function handleIncomingMessage(message) {
  try {
    if (!message.body) return;

    const rawText = message.body.trim();
    if (!rawText) return;

    const allowed = await isAllowedBotChat(message);
    if (!allowed) return;

    const externalId = peerPhone(message);
    if (!externalId || externalId === 'status' || externalId.length < 6) return;

    if (externalId.startsWith('120363') && String(message.from || '').includes('@g.us')) {
      return;
    }

    const ctx = buildCtx(message, externalId);

    // Message yourself: bot replies are also fromMe — never treat them as input
    if (isBotEcho(ctx.key, rawText, message.fromMe)) {
      console.log(`[skip] bot echo ${ctx.key}`);
      return;
    }

    // WhatsApp is a shared inbox: stay silent unless this is clearly for us
    const flow = router.pendingFlowFor(ctx.key);
    const midFlow = flow.walletAdd || flow.claimMenu || flow.unlock;
    if (!router.isFlizyCommand(ctx, rawText) && !midFlow) {
      return;
    }

    console.log(
      `[msg] fromMe=${Boolean(message.fromMe)} ${ctx.key}${
        message.fromMe ? ' (Message yourself)' : ' (inbound)'
      }`
    );

    await router.handle(ctx, rawText);
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
  const id = (message.id && message.id._serialized) || (message.id && message.id.id) || null;
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
