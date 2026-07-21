/**
 * Never leak secrets into WhatsApp replies or logs.
 */

const SECRET_PATTERNS = [
  /0x[a-fA-F0-9]{64}/g, // private keys / long hex secrets
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, // JWT-ish
  /sk_live_[a-zA-Z0-9]+/gi,
  /service_role/gi,
];

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
  safeLog,
};
