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
  try {
    if (!stored || !String(stored).includes(':')) return false;
    const parts = String(stored).split(':');
    const saltHex = parts[0];
    const hashHex = parts.slice(1).join(':'); // tolerate extra colons
    if (!saltHex || !hashHex || saltHex.length % 2 !== 0 || hashHex.length % 2 !== 0) {
      return false;
    }
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(String(pin), salt, expected.length, SCRYPT_PARAMS);
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
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
