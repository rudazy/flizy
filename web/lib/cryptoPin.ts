import crypto from 'crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32, SCRYPT_PARAMS);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  if (!stored || !String(stored).includes(':')) return false;
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pin), salt, expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(expected, actual);
}

export function hashPassword(password: string): string {
  return hashPin(password);
}

export function verifyPassword(password: string, stored: string): boolean {
  return verifyPin(password, stored);
}
