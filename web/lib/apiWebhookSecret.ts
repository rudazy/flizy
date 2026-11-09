import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Flizy Pay API webhook endpoint secrets.
 *
 * A secret signs every delivery (web/lib/apiWebhookSign.ts), so Flizy must be
 * able to read it back: it cannot be stored as a hash like an API key. It is
 * shown to the platform once and stored only encrypted, AES-256-GCM under
 * API_WEBHOOK_KEY (server only: Vercel encrypts at registration, the VPS
 * decrypts to sign), with the endpoint's id as associated data, so a
 * ciphertext copied onto another endpoint does not decrypt.
 *
 * Stored form: v1:<iv>:<tag>:<ciphertext>, each base64url. The VPS has the same
 * code (lib/api/webhookSecret.js); a test keeps the two in step.
 *
 * Imports only crypto, so node --test loads this file directly.
 */

const PREFIX = 'whsec_';

export class WebhookKeyMissing extends Error {}

/** API_WEBHOOK_KEY: 32 bytes as 64 hex characters. */
export function webhookKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = String(env.API_WEBHOOK_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new WebhookKeyMissing('API_WEBHOOK_KEY must be 64 hex characters');
  return Buffer.from(raw, 'hex');
}

/** A new secret to show once, and the last characters to tell it apart later. */
export function generateWebhookSecret(): { secret: string; hint: string } {
  const secret = PREFIX + randomBytes(32).toString('base64url');
  return { secret, hint: secret.slice(-4) };
}

export function encryptWebhookSecret(secret: string, endpointId: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(endpointId, 'utf8'));
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptWebhookSecret(stored: string, endpointId: string, key: Buffer): string {
  const [v, iv, tag, ct] = String(stored || '').split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('webhook secret is not in the v1 form');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(endpointId, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
