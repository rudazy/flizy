/**
 * Never leak secrets into WhatsApp replies or logs.
 */

const SECRET_PATTERNS = [
  /0x[a-fA-F0-9]{64}/g, // private keys / long hex secrets
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, // JWT-ish
  /sk_live_[a-zA-Z0-9]+/gi,
  /service_role/gi,
];

/** Control characters, including the newline that would forge a preview line. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * @param {unknown} err
 * @returns {string}
 */
function publicErrorMessage(err) {
  if (!err) return 'Unknown error';
  let msg =
    (err && err.shortMessage) ||
    (err && err.reason) ||
    (err && err.message) ||
    String(err);

  for (const re of SECRET_PATTERNS) {
    msg = msg.replace(re, '[redacted]');
  }

  // Truncate huge dumps
  if (msg.length > 280) {
    msg = msg.slice(0, 277) + '...';
  }
  return msg;
}

/**
 * A label that came from somebody else, made safe to print on a confirm screen.
 *
 * Confirm previews are fixed-width "Label:  value" lines, so a newline inside a
 * value lets whoever set it forge extra lines: a second To:, a fake note, a
 * different amount. A payment requester's display name is exactly that kind of
 * value, so it is flattened to one line, stripped of control characters and
 * capped before it is rendered.
 *
 * @param {unknown} raw
 * @param {number} [maxLength]
 * @returns {string} empty string when there is nothing usable left
 */
function displaySafeLabel(raw, maxLength = 40) {
  const flat = String(raw ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  // ASCII on purpose. web/lib/claimRecipient.ts mirrors this function, and the
  // two disagreed here: a label over maxLength truncated with U+2026 in chat and
  // with three dots on the web. Same input, two renderings. ASCII is the side
  // that moves, so the mirror can stay byte-identical.
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}...` : flat;
}

/**
 * @param {string} line
 */
function safeLog(line) {
  let out = String(line);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, '[redacted]');
  }
  console.log(out);
}

module.exports = {
  publicErrorMessage,
  displaySafeLabel,
  safeLog,
};
