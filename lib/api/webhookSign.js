/**
 * Signing for Flizy Pay API webhook deliveries, on the VPS.
 *
 * The same scheme the site documents and tests (web/lib/apiWebhookSign.ts):
 * `Flizy-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`
 * under the endpoint's secret. A receiver recomputes it over the raw body,
 * compares in constant time and refuses a timestamp outside five minutes. A
 * test keeps the two in step.
 */

const { createHmac } = require('crypto');

const SIGNATURE_HEADER = 'Flizy-Signature';

function signWebhook(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('webhook secret is required');
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

module.exports = { SIGNATURE_HEADER, signWebhook };
