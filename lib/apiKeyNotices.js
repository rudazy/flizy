/**
 * Ask the site to email platform owners about API key events it has not
 * mailed yet (web/app/api/internal/api-key-notices).
 *
 * Changes made on the site are mailed at once. This catches the rest: a
 * permission Flizy grants directly in the database, which the api_key_events
 * trigger records but no route sees. Runs in the WhatsApp process every few
 * minutes. Same secret and the same https-only rule as the payment notice
 * (lib/paymentNotice.js): the secret is never sent to a plain-http host other
 * than a local development site.
 */

const { config } = require('./config');
const { publicErrorMessage } = require('./sanitize');

const PATH = '/api/internal/api-key-notices';
const INTERVAL_MS = 3 * 60 * 1000;
const TIMEOUT_MS = 10_000;

function apiKeyNoticeUrl(siteUrl = config.siteUrl) {
  let url;
  try {
    url = new URL(PATH, siteUrl);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  return url.toString();
}

/** @returns {Promise<'sent'|'unconfigured'|'failed'>} */
async function pumpApiKeyNotices(deps = {}) {
  const secret = deps.secret ?? process.env.SECURITY_MAIL_SECRET;
  const url = apiKeyNoticeUrl(deps.siteUrl ?? config.siteUrl);
  if (!secret || !url) return 'unconfigured';
  const doFetch = deps.fetch || fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? 'sent' : 'failed';
  } catch (err) {
    console.warn('[api-key-notices] request failed:', publicErrorMessage(err));
    return 'failed';
  }
}

function startApiKeyNoticePump(deps = {}) {
  if (!apiKeyNoticeUrl(deps.siteUrl ?? config.siteUrl) || !(deps.secret ?? process.env.SECURITY_MAIL_SECRET)) {
    console.warn('[api-key-notices] SECURITY_MAIL_SECRET or an https SITE_URL is missing; key permission changes are not emailed');
    return null;
  }
  const timer = setInterval(() => void pumpApiKeyNotices(deps), deps.intervalMs || INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = { apiKeyNoticeUrl, pumpApiKeyNotices, startApiKeyNoticePump };
