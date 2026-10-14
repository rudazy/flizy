/**
 * Ask the site to email the account owner that a chat was linked or unlinked.
 *
 * The bots hold no mail credentials and should not: the site already sends
 * mail, and one more SMTP password on the bot host would be one more secret
 * next to the WhatsApp session. So the bot names the account and the kind of
 * event, and web/app/api/internal/security-mail looks that event up in
 * identity_events and writes and sends the mail itself.
 *
 * Never throws. The link or unlink has already happened by the time this runs,
 * and a notice that fails must not undo it or stop the reply in chat.
 */

const { config } = require('./config');
const { publicErrorMessage } = require('./sanitize');

const PATH = '/api/internal/security-mail';
const TIMEOUT_MS = 5000;
const KINDS = new Set(['linked', 'unlinked']);

/**
 * Where the request goes, or null when sending the secret there would be
 * unsafe: anything other than https, except a local development site.
 */
function securityMailUrl(siteUrl = config.siteUrl) {
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

/**
 * @param {string} accountId
 * @param {'linked'|'unlinked'} kind
 * @param {{ fetch?: typeof fetch, secret?: string, siteUrl?: string }} [deps] for tests
 * @returns {Promise<'sent'|'skipped'|'unconfigured'|'failed'>}
 */
async function requestSecurityMail(accountId, kind, deps = {}) {
  if (!accountId || !KINDS.has(kind)) return 'skipped';
  const secret = deps.secret ?? process.env.SECURITY_MAIL_SECRET;
  const url = securityMailUrl(deps.siteUrl ?? config.siteUrl);
  if (!secret || !url) {
    console.warn('[security-mail] SECURITY_MAIL_SECRET or an https SITE_URL is missing; the owner was not emailed');
    return 'unconfigured';
  }
  const doFetch = deps.fetch || fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ accountId, kind }),
      // A redirect would carry the bearer token to wherever it points.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[security-mail] the site answered ${res.status}; the owner may not have been emailed`);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.warn('[security-mail] request failed:', publicErrorMessage(err));
    return 'failed';
  }
}

module.exports = { requestSecurityMail, securityMailUrl };
