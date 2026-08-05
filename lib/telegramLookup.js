/**
 * Resolve a Telegram username (or user id) to the immutable numeric user id.
 *
 * Claims and channel_identities store the id, never the handle. Handles change
 * and can be reassigned; the numeric user id does not.
 *
 * Resolution order:
 *   1. Numeric user id typed directly
 *   2. Bot API getChat(@username) when TELEGRAM_BOT_TOKEN is available
 *   3. Already-linked Flizy identities (display_handle), so people on Flizy
 *      can still be paid by name when getChat cannot see them
 *
 * Pure enough to inject fetch / a getChat function in tests.
 */

const { getSupabase } = require('./supabase');

/** Telegram usernames: 5–32 chars, start with a letter, then letters/digits/_. */
const TG_USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

/**
 * @param {string} raw
 * @returns {string} bare username or empty
 */
function normalizeTelegramUsername(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/^@+/, '');
  if (!s || s.length < 5 || s.length > 32) return '';
  if (!TG_USERNAME_RE.test(s)) return '';
  return s;
}

/** Telegram user ids are large positive integers (string-safe). */
function isTelegramUserId(raw) {
  return /^\d{5,20}$/.test(String(raw || '').trim());
}

/**
 * @param {(body: string) => string} [cmd]
 * @returns {string}
 */
function telegramInvalidMessage(cmd) {
  const example = cmd
    ? cmd('send 0.001 to @alice_crypto on telegram')
    : 'flizy send 0.001 to @alice_crypto on telegram';
  return [
    'That does not look like a Telegram username or user id.',
    `Example: ${example}`,
    'Also: telegram:@alice_crypto or on tg',
  ].join('\n');
}

/**
 * @param {(body: string) => string} [cmd]
 * @returns {string}
 */
function telegramNotFoundMessage(cmd) {
  const example = cmd
    ? cmd('send 0.001 to @alice_crypto on telegram')
    : 'flizy send 0.001 to @alice_crypto on telegram';
  return [
    'Could not find that Telegram user.',
    'Check the spelling (typos create a claim for the wrong person).',
    '',
    'They need a public @username, or you can use their numeric user id.',
    `Example: ${example}`,
  ].join('\n');
}

/**
 * @param {(body: string) => string} [cmd]
 * @returns {string}
 */
function telegramAmbiguousMessage(cmd) {
  return [
    'That Telegram name matches more than one Flizy account.',
    'Use their Telegram user id so the right person is paid.',
    cmd
      ? `Example: ${cmd('send 0.001 to 123456789 on telegram')}`
      : 'Example: flizy send 0.001 to 123456789 on telegram',
  ].join('\n');
}

/**
 * @param {(body: string) => string} [cmd]
 * @returns {string}
 */
function telegramLookupUnavailableMessage(cmd) {
  return [
    'Telegram username lookup is not configured on this bot.',
    'An admin must set TELEGRAM_BOT_TOKEN (same token as the Telegram client).',
    '',
    'You can still send to a numeric Telegram user id, or to a name already',
    'linked on Flizy:',
    cmd
      ? `  ${cmd('send 0.001 to 123456789 on telegram')}`
      : '  flizy send 0.001 to 123456789 on telegram',
  ].join('\n');
}

/**
 * Look up a linked Telegram identity by display handle (case-insensitive).
 * @param {string} handle
 * @returns {Promise<{ id: string, login: string } | null>}
 */
async function resolveFromLinkedHandle(handle) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('channel_identities')
    .select('external_id, display_handle')
    .eq('channel', 'telegram')
    .ilike('display_handle', handle)
    .limit(5);

  if (error) {
    const err = new Error('Could not look up that Telegram user. Try again shortly.');
    err.code = 'TELEGRAM_LOOKUP_FAILED';
    throw err;
  }

  const rows = data || [];
  if (rows.length === 1 && rows[0].external_id && /^\d+$/.test(String(rows[0].external_id))) {
    return {
      id: String(rows[0].external_id),
      login: String(rows[0].display_handle || handle).replace(/^@+/, ''),
    };
  }
  if (rows.length > 1) {
    const err = new Error(telegramAmbiguousMessage());
    err.code = 'TELEGRAM_AMBIGUOUS';
    throw err;
  }
  return null;
}

/**
 * Optional display handle for a known numeric id already on Flizy.
 * @param {string} externalId
 */
async function displayHandleForId(externalId) {
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('channel_identities')
      .select('display_handle')
      .eq('channel', 'telegram')
      .eq('external_id', externalId)
      .maybeSingle();
    const h = data?.display_handle ? String(data.display_handle).replace(/^@+/, '') : '';
    return h || '';
  } catch {
    return '';
  }
}

/**
 * Bot API getChat(@username) → immutable id.
 * @param {string} handle bare username
 * @param {{ getChat?: (chatId: string) => Promise<object>, token?: string, fetch?: typeof fetch }} opts
 */
async function resolveViaBotApi(handle, opts = {}) {
  if (typeof opts.getChat === 'function') {
    const chat = await opts.getChat(`@${handle}`);
    return profileFromChat(chat, handle);
  }

  const token = String(opts.token || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return null;

  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') return null;

  const url = `https://api.telegram.org/bot${token}/getChat`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: `@${handle}` }),
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    const err = new Error('Could not look up that Telegram user. Try again shortly.');
    err.code = 'TELEGRAM_LOOKUP_FAILED';
    throw err;
  }

  if (!payload.ok) {
    // 400 "chat not found" and similar → treat as unknown user
    const desc = String(payload.description || '').toLowerCase();
    if (
      res.status === 400 ||
      desc.includes('chat not found') ||
      desc.includes('user not found') ||
      desc.includes('username not found')
    ) {
      return null;
    }
    if (res.status === 429 || payload.error_code === 429) {
      const err = new Error('Telegram is rate-limiting lookups. Try again in a minute.');
      err.code = 'TELEGRAM_RATE_LIMIT';
      throw err;
    }
    const err = new Error('Could not look up that Telegram user. Try again shortly.');
    err.code = 'TELEGRAM_LOOKUP_FAILED';
    throw err;
  }

  return profileFromChat(payload.result, handle);
}

/**
 * @param {object} chat Telegram Chat
 * @param {string} fallbackHandle
 * @returns {{ id: string, login: string } | null}
 */
function profileFromChat(chat, fallbackHandle) {
  if (!chat || chat.id == null) return null;
  const id = String(chat.id);
  // Private users are positive; groups/channels can be negative — refuse those.
  if (!/^\d+$/.test(id)) return null;
  const login = chat.username
    ? String(chat.username).replace(/^@+/, '')
    : String(fallbackHandle || '').replace(/^@+/, '');
  return { id, login: login || '' };
}

/**
 * @param {string} raw handle or numeric user id
 * @param {{ getChat?: Function, token?: string, fetch?: typeof fetch, skipDb?: boolean }} [opts]
 * @returns {Promise<{ id: string, login: string } | null>}
 */
async function resolveTelegramUser(raw, opts = {}) {
  const s = String(raw || '')
    .trim()
    .replace(/^@+/, '');
  if (!s) {
    const err = new Error(telegramInvalidMessage());
    err.code = 'TELEGRAM_INVALID';
    throw err;
  }

  // Direct numeric id — never invent a handle from digits.
  if (isTelegramUserId(s)) {
    const login = opts.skipDb ? '' : await displayHandleForId(s);
    return { id: s, login };
  }

  const handle = normalizeTelegramUsername(s);
  if (!handle) {
    const err = new Error(telegramInvalidMessage());
    err.code = 'TELEGRAM_INVALID';
    throw err;
  }

  // Prefer live Telegram resolution so claims bind to the id at send time.
  let fromApi = null;
  try {
    fromApi = await resolveViaBotApi(handle, opts);
  } catch (err) {
    // Rate limits should surface; other API failures fall through to linked identities.
    if (err && err.code === 'TELEGRAM_RATE_LIMIT') throw err;
    if (err && err.code && !['TELEGRAM_LOOKUP_FAILED'].includes(err.code)) throw err;
  }
  if (fromApi) return fromApi;

  // No token / chat not found → people already linked on Flizy by handle.
  if (!opts.skipDb) {
    const linked = await resolveFromLinkedHandle(handle);
    if (linked) return linked;
  }

  // Token missing and not on Flizy: tell the operator, not a silent not-found.
  const token = String(opts.token || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token && typeof opts.getChat !== 'function') {
    const err = new Error(telegramLookupUnavailableMessage());
    err.code = 'TELEGRAM_LOOKUP_UNAVAILABLE';
    throw err;
  }

  return null;
}

module.exports = {
  TG_USERNAME_RE,
  normalizeTelegramUsername,
  isTelegramUserId,
  telegramInvalidMessage,
  telegramNotFoundMessage,
  telegramAmbiguousMessage,
  telegramLookupUnavailableMessage,
  resolveTelegramUser,
  resolveFromLinkedHandle,
  profileFromChat,
};
