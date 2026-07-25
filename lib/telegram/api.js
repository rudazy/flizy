/**
 * Minimal Telegram Bot API client.
 *
 * Uses global fetch (Node 18+). No third-party Telegram library: the surface we
 * need is four methods, and a bot token is not something to hand to an extra
 * dependency.
 *
 * The token appears only in request URLs. Every error is scrubbed before it can
 * reach a log line.
 */

const API_ROOT = 'https://api.telegram.org';

/** Telegram hard limit for a text message. */
const MAX_MESSAGE_LEN = 4096;

class TelegramError extends Error {
  constructor(message, { code, retryAfter } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.code = code || null;
    this.retryAfter = retryAfter || null;
  }
}

class TelegramApi {
  /**
   * @param {string} token bot token from env, never hardcoded and never logged
   */
  constructor(token) {
    const value = String(token || '').trim();
    if (!value) {
      throw new Error('TELEGRAM_BOT_TOKEN is missing. Set it in .env and restart.');
    }
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(value)) {
      throw new Error('TELEGRAM_BOT_TOKEN does not look like a Telegram bot token.');
    }
    Object.defineProperty(this, 'token', { value, enumerable: false, writable: false });
  }

  /** Remove the token from any string before it is logged or thrown. */
  scrub(text) {
    return String(text || '').split(this.token).join('<token>');
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{ timeoutMs?: number }} [opts]
   */
  async call(method, params = {}, opts = {}) {
    const url = `${API_ROOT}/bot${this.token}/${method}`;
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs || 20000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? 'request timed out' : 'network error';
      throw new TelegramError(`${method}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramError(`${method}: invalid response (${response.status})`);
    }

    if (!payload.ok) {
      const description = this.scrub(payload.description || `HTTP ${response.status}`);
      throw new TelegramError(`${method}: ${description}`, {
        code: payload.error_code,
        retryAfter: payload.parameters?.retry_after || null,
      });
    }

    return payload.result;
  }

  getMe() {
    return this.call('getMe');
  }

  /**
   * @param {{ offset?: number, timeoutSec?: number, allowedUpdates?: string[] }} p
   */
  getUpdates({ offset, timeoutSec = 30, allowedUpdates } = {}) {
    return this.call(
      'getUpdates',
      {
        offset,
        timeout: timeoutSec,
        allowed_updates: allowedUpdates || ['message', 'callback_query'],
      },
      // Long poll: wait past the server-side timeout before giving up
      { timeoutMs: (timeoutSec + 15) * 1000 }
    );
  }

  /**
   * Send text, split into Telegram-sized chunks.
   * @param {number|string} chatId
   * @param {string} text
   * @param {{ replyMarkup?: object }} [opts]
   */
  async sendMessage(chatId, text, opts = {}) {
    const body = String(text || '');
    const chunks = splitMessage(body);
    let last = null;
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      last = await this.call('sendMessage', {
        chat_id: chatId,
        text: chunks[i],
        disable_web_page_preview: true,
        // Keyboards belong on the final chunk only
        reply_markup: isLast ? opts.replyMarkup : undefined,
      });
    }
    return last;
  }

  answerCallbackQuery(callbackQueryId, text) {
    return this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || undefined,
    });
  }

  setMyCommands(commands) {
    return this.call('setMyCommands', { commands });
  }

  /** Polling and webhooks are mutually exclusive. */
  deleteWebhook() {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }
}

/**
 * Split on line boundaries so plans and receipts stay readable.
 * @param {string} text
 * @returns {string[]}
 */
function splitMessage(text) {
  if (text.length <= MAX_MESSAGE_LEN) return [text || ' '];

  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_MESSAGE_LEN) {
      if (current) chunks.push(current);
      // A single line longer than the limit: hard split it
      let rest = line;
      while (rest.length > MAX_MESSAGE_LEN) {
        chunks.push(rest.slice(0, MAX_MESSAGE_LEN));
        rest = rest.slice(MAX_MESSAGE_LEN);
      }
      current = rest;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Inline keyboard from router button rows. */
function inlineKeyboard(rows) {
  return {
    inline_keyboard: (rows || []).map((row) =>
      row.map((b) => ({ text: b.label, callback_data: b.value }))
    ),
  };
}

/** One-tap contact share. Telegram verifies the number; typed text cannot. */
function requestContactKeyboard(label = 'Share my number') {
  return {
    keyboard: [[{ text: label, request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function removeKeyboard() {
  return { remove_keyboard: true };
}

module.exports = {
  TelegramApi,
  TelegramError,
  splitMessage,
  inlineKeyboard,
  requestContactKeyboard,
  removeKeyboard,
  MAX_MESSAGE_LEN,
};
