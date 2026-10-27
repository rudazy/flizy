/**
 * Ask the site to record a payment that reached an account, and to email it.
 *
 * The bots hold no mail credentials. This names the account and the payment.
 * The site writes the sentence, chooses the address on the account, and stores
 * the row. The bot cannot choose the email address or the link.
 *
 * Never throws. The payment has already landed.
 */

const { config } = require('./config');
const { publicErrorMessage } = require('./sanitize');

const PATH = '/api/internal/payment-notice';
const TIMEOUT_MS = 5000;

/**
 * Where the request goes, or null when sending the secret there would be
 * unsafe: anything other than https, except a local development site.
 */
function paymentNoticeUrl(siteUrl = config.siteUrl) {
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
 * @param {{ txHash?: string, amount?: string, asset?: string, fromLabel?: string, note?: string|null, tag?: string, part?: string|null }} fields
 * @param {{ fetch?: typeof fetch, secret?: string, siteUrl?: string }} [deps]
 * @returns {Promise<'sent'|'skipped'|'unconfigured'|'failed'>}
 */
async function requestPaymentNotice(accountId, fields, deps = {}) {
  if (!accountId || !fields || !fields.txHash) return 'skipped';
  const secret = deps.secret ?? process.env.SECURITY_MAIL_SECRET;
  const url = paymentNoticeUrl(deps.siteUrl ?? config.siteUrl);
  if (!secret || !url) {
    console.warn('[payment-notice] SECURITY_MAIL_SECRET or an https SITE_URL is missing; the owner was not emailed');
    return 'unconfigured';
  }
  const doFetch = deps.fetch || fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId,
        txHash: fields.txHash,
        amount: fields.amount,
        asset: fields.asset,
        fromLabel: fields.fromLabel,
        note: fields.note || null,
        tag: fields.tag === 'sale' ? 'sale' : 'payment',
        part: fields.part || null,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[payment-notice] the site answered ${res.status}; the owner may not have been emailed`);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.warn('[payment-notice] request failed:', publicErrorMessage(err));
    return 'failed';
  }
}

module.exports = { requestPaymentNotice, paymentNoticeUrl };
