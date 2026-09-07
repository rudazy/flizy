/**
 * How a command is written, for one channel.
 *
 * WhatsApp reads `flizy unlock`, Telegram reads `/unlock`. Handlers have a ctx
 * and can ask `cmd()` directly. Two callers cannot:
 *
 *   - **The engine.** It has no ctx by design -- clients are adapters -- so its
 *     refusals used to hardcode the WhatsApp form and were simply wrong on
 *     Telegram, in twenty-one places.
 *   - **A notification.** `notifyAccount` composes one body and fans it out to
 *     every channel an account has linked, so there is no single correct
 *     rendering at the moment it is written. Someone linked to both channels
 *     would get one of them wrong whatever ctx was passed.
 *
 * So the copy carries a marker and the rendering happens at delivery, where the
 * channel is finally known. `{{cmd:unlock your-pin}}` becomes `/unlock
 * your-pin` or `flizy unlock your-pin` and nothing else -- the substitution
 * produces a command string, never behaviour, so a marker echoed back from a
 * user's own note is inert.
 */

const { CHANNELS, normalizeChannel } = require('../identity');

/** Deliberately loud: an unexpanded marker should be visible, not silent. */
const CMD_MARKER = /\{\{cmd:([^{}]{1,80})\}\}/g;

/**
 * One command, rendered for one channel. The single definition of the dialect.
 *
 * @param {string} body command without any prefix, e.g. 'unlock your-pin'
 * @param {string} channel
 * @returns {string}
 */
function renderCommand(body, channel) {
  const text = String(body == null ? '' : body).trim();
  return normalizeChannel(channel) === CHANNELS.TELEGRAM ? `/${text}` : `flizy ${text}`;
}

/**
 * Expand every `{{cmd:...}}` marker in a message for one channel.
 *
 * Cheap on the common path: most messages carry no marker and return untouched.
 *
 * @param {unknown} text
 * @param {string} channel
 * @returns {string}
 */
function renderCommands(text, channel) {
  const s = String(text == null ? '' : text);
  if (!s.includes('{{cmd:')) return s;
  return s.replace(CMD_MARKER, (_match, body) => renderCommand(body, channel));
}

module.exports = {
  renderCommand,
  renderCommands,
};
