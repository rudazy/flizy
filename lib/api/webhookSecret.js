/**
 * Flizy Pay API webhook secrets, read back on the VPS to sign deliveries.
 *
 * The same scheme as the site's web/lib/apiWebhookSecret.ts, which encrypts a
 * secret when an endpoint is registered: AES-256-GCM under API_WEBHOOK_KEY (64
 * hex characters), the endpoint's id as associated data, stored as
 * v1:<iv>:<tag>:<ciphertext> in base64url. A test keeps the two in step.
 */

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

/** API_WEBHOOK_KEY as 32 bytes, or null when it is not set (delivery then waits). */
function webhookKey(env = process.env) {
  const raw = String(env.API_WEBHOOK_KEY || '').trim();
  if (!raw) return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('API_WEBHOOK_KEY must be 64 hex characters');
  return Buffer.from(raw, 'hex');
}

function decryptWebhookSecret(stored, endpointId, key) {
  const [v, iv, tag, ct] = String(stored || '').split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('webhook secret is not in the v1 form');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(String(endpointId), 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** The site's encryption, for tests and scripts on this side. */
function encryptWebhookSecret(secret, endpointId, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(endpointId), 'utf8'));
  const ct = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

module.exports = { webhookKey, decryptWebhookSecret, encryptWebhookSecret };
