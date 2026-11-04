import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signing for Flizy Pay API webhooks.
 *
 * Header: `Flizy-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`
 * under the endpoint's own secret. A receiver recomputes it over the raw body,
 * compares in constant time, and refuses a timestamp outside the replay window,
 * so a captured delivery cannot be replayed later. Every event also carries a
 * unique id (api_webhook_events.id); receivers dedupe by it, since a retry
 * delivers the same event again.
 *
 * Phase 1 builds and tests the signing; delivery to real endpoints comes later.
 * Imports only crypto, so node --test loads this file directly.
 */

export const SIGNATURE_HEADER = 'Flizy-Signature';
/** How old a delivery may be before a receiver must refuse it. */
export const REPLAY_WINDOW_SEC = 300;

function mac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

export function signWebhook(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  if (!secret) throw new Error('webhook secret is required');
  return `t=${timestamp},v1=${mac(secret, timestamp, body)}`;
}

/** What a receiver runs: valid signature, and not older or newer than the window. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null,
  now = Math.floor(Date.now() / 1000),
  windowSec = REPLAY_WINDOW_SEC
): boolean {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const t = Number(parts.t);
  const v1 = String(parts.v1 || '');
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(now - t) > windowSec) return false;
  const expected = Buffer.from(mac(secret, t, body), 'hex');
  return timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}
