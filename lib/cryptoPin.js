const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * @param {string} pin
 * @returns {string} salt:hash hex
 */
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32, SCRYPT_PARAMS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * @param {string} pin
 * @param {string} stored salt:hash
 */
function verifyPin(pin, stored) {
  if (!stored || !String(stored).includes(':')) return false;
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pin), salt, expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * Lightweight password hash for site accounts (same scheme).
 */
function hashPassword(password) {
  return hashPin(password);
}

function verifyPassword(password, stored) {
  return verifyPin(password, stored);
}

module.exports = {
  hashPin,
  verifyPin,
  hashPassword,
  verifyPassword,
};
