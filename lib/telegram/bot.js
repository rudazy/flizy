/**
 * Flizy Telegram client.
 *
 * Adapter only. It turns a Telegram update into a router ctx and nothing else:
 * no policy, no limits, no wallet logic. Long polling, so no public webhook URL
 * is needed to run it.
 */

const { config } = require('../config');
const { publicErrorMessage } = require('../sanitize');
const { CHANNELS, refreshTelegramDisplayHandle } = require('../identity');
const { registerChannelSender, startOutboxDrain } = require('../notify');
const router = require('../router');
const {
  TelegramApi,
  inlineKeyboard,
  requestContactKeyboard,
  removeKeyboard,
} = require('./api');

const CHANNEL = CHANNELS.TELEGRAM;

class TelegramBot {
  /**
   * @param {{ token: string, pollTimeoutSec?: number }} opts
   */
  constructor({ token, pollTimeoutSec }) {
    this.api = new TelegramApi(token);
    this.pollTimeoutSec = pollTimeoutSec || config.telegramPollTimeoutSec || 30;
    this.offset = undefined;
    this.running = false;
    this.me = null;
    this.backoffMs = 1000;
  }

  // -------------------------------------------------------------------------
  // Context
  // -------------------------------------------------------------------------

  /**
   * @param {object} p
   * @param {number|string} p.chatId
   * @param {number|string} p.userId
   * @param {string} [p.username] public @username without @ (display only)
   */
  buildCtx({ chatId, userId, username }) {
    const externalId = String(userId);
    const api = this.api;
    const handle = username ? String(username).replace(/^@+/, '').trim() : '';

    return {
      channel: CHANNEL,
      externalId,
      key: `${CHANNEL}:${externalId}`,
      // Stored on link as display_handle; claims always match externalId (user id).
      displayHandle: handle || null,
      raw: { chatId, userId, username: handle || null },

      async reply(text, opts = {}) {
        const replyMarkup = opts.buttons ? inlineKeyboard(opts.buttons) : undefined;
        return api.sendMessage(chatId, text, { replyMarkup });
      },

      /**
       * Telegram never exposes a user's number without an explicit contact share,
       * so there is nothing to read here. The number arrives via handleContact.
       */
      resolveVerifiedPhone: async () => null,

      async requestPhone(text) {
        return api.sendMessage(chatId, text, { replyMarkup: requestContactKeyboard() });
      },
    };
  }

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  async handleUpdate(update) {
    if (update.message) {
      await this.handleMessage(update.message);
      return;
    }
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  async handleMessage(message) {
    const chat = message.chat || {};
    const from = message.from || {};

    // Private chats only. A shared group is not a wallet.
    if (chat.type !== 'private') return;
    if (from.is_bot) return;
    if (!from.id) return;

    const ctx = this.buildCtx({
      chatId: chat.id,
      userId: from.id,
      username: from.username || null,
    });

    // Keep display_handle fresh so others can pay @username on Flizy.
    // Fire-and-forget: never block chat on a soft metadata write.
    if (from.username) {
      void refreshTelegramDisplayHandle(String(from.id), from.username);
    }

    if (message.contact) {
      await this.handleContact(ctx, message);
      return;
    }

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) return;

    await router.handle(ctx, text);
  }

  /**
   * Contact share. Accept the number only when Telegram says the contact IS the
   * sender: contact.user_id must equal the sender's id. Anything else is a
   * forwarded contact card, which proves nothing.
   */
  async handleContact(ctx, message) {
    const contact = message.contact || {};
    const fromId = message.from?.id;
    const verified = Boolean(contact.user_id) && String(contact.user_id) === String(fromId);

    if (!verified) {
      await this.api.sendMessage(
        ctx.raw.chatId,
        'That is someone else\'s contact card. Use the Share my number button so Telegram can verify it is yours.',
        { replyMarkup: removeKeyboard() }
      );
      return;
    }

    // Clear the custom keyboard, then let the router apply the identity rules
    await this.api.sendMessage(ctx.raw.chatId, 'Checking your number...', {
      replyMarkup: removeKeyboard(),
    });

    await router.handleSharedPhone(ctx, {
      phone: contact.phone_number,
      verified: true,
    });
  }

  /** Inline Confirm / Cancel buttons map onto the same words users can type. */
  async handleCallbackQuery(query) {
    const data = String(query.data || '').trim().toLowerCase();
    const chat = query.message?.chat;
    const from = query.from || {};

    try {
      await this.api.answerCallbackQuery(query.id);
    } catch (err) {
      console.warn('[telegram] answerCallbackQuery:', publicErrorMessage(err));
    }

    if (!chat || chat.type !== 'private' || !from.id) return;
    if (data !== 'confirm' && data !== 'cancel') return;

    const ctx = this.buildCtx({
      chatId: chat.id,
      userId: from.id,
      username: from.username || null,
    });
    if (from.username) {
      void refreshTelegramDisplayHandle(String(from.id), from.username);
    }
    await router.handle(ctx, data);
  }

  // -------------------------------------------------------------------------
  // Outbound for notifications
  // -------------------------------------------------------------------------

  /**
   * Telegram delivery is a plain HTTPS call, so any process holding the token
   * can notify a Telegram user directly.
   * @param {string} externalId Telegram user id (also the private chat id)
   * @param {string} body
   */
  sendToIdentity(externalId, body) {
    return this.api.sendMessage(String(externalId), String(body));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start() {
    this.me = await this.api.getMe();
    console.log(`Flizy Telegram client is ready: @${this.me.username}`);

    if (
      config.telegramBotUsername &&
      config.telegramBotUsername.toLowerCase() !== String(this.me.username || '').toLowerCase()
    ) {
      console.warn(
        `[telegram] TELEGRAM_BOT_USERNAME is ${config.telegramBotUsername} but the token belongs to @${this.me.username}. Site deep links will point at the wrong bot.`
      );
    }

    // Polling and webhooks cannot both be active
    try {
      await this.api.deleteWebhook();
    } catch (err) {
      console.warn('[telegram] deleteWebhook:', publicErrorMessage(err));
    }

    try {
      await this.api.setMyCommands(router.commandMenu());
    } catch (err) {
      console.warn('[telegram] setMyCommands:', publicErrorMessage(err));
    }

    registerChannelSender(CHANNEL, (externalId, body) => this.sendToIdentity(externalId, body));
    startOutboxDrain(CHANNEL, config.outboxDrainMs);

    this.running = true;
    this.poll();
  }

  stop() {
    this.running = false;
  }

  async poll() {
    while (this.running) {
      try {
        const updates = await this.api.getUpdates({
          offset: this.offset,
          timeoutSec: this.pollTimeoutSec,
        });
        this.backoffMs = 1000;

        for (const update of updates || []) {
          this.offset = update.update_id + 1;
          try {
            await this.handleUpdate(update);
          } catch (err) {
            console.error('[telegram] update failed:', publicErrorMessage(err));
          }
        }
      } catch (err) {
        // 409 means another poller is running against this token
        if (err.code === 409) {
          console.error(
            '[telegram] another process is polling this bot token. Stop it, then restart this service.'
          );
        } else {
          console.warn('[telegram] poll failed:', publicErrorMessage(err));
        }
        const wait = err.retryAfter ? err.retryAfter * 1000 : this.backoffMs;
        await sleep(wait);
        this.backoffMs = Math.min(this.backoffMs * 2, 60000);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { TelegramBot };
