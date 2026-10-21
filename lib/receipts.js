/**
 * The receipt link chat hands a sender right after a payment confirms.
 *
 * Same token rules as web/lib/receipts.ts, which serves the page and lets
 * either party share from the site: 22 characters of base64url, made once,
 * filled only into an empty slot, and never derived from the transfer id
 * (supabase/migrations/20261021140000_transfer_receipts.sql). Here the caller
 * is the bot, which only asks about a transfer it just confirmed for the
 * account it is talking to, so no further party check is needed.
 */

const { randomBytes } = require('crypto');

const RECEIPT_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The receipt URL for a confirmed transfer, or null when there is none to give
 * (no row, not confirmed, or a database without the receipt column). Never
 * throws: a payment that went through must not read as failed because its
 * receipt link could not be made.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string|null|undefined} transferId
 * @param {string} siteUrl
 * @returns {Promise<string|null>}
 */
async function receiptUrlFor(supabase, transferId, siteUrl) {
  if (!transferId) return null;
  try {
    const read = async () => {
      const { data, error } = await supabase
        .from('transfers')
        .select('status, kind, receipt_token')
        .eq('id', transferId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    };
    let row = await read();
    if (!row || row.status !== 'confirmed' || String(row.kind || 'transfer') !== 'transfer') return null;
    if (!row.receipt_token) {
      const { error } = await supabase
        .from('transfers')
        .update({ receipt_token: randomBytes(16).toString('base64url') })
        .eq('id', transferId)
        .is('receipt_token', null);
      if (error) throw new Error(error.message);
      row = await read();
    }
    const token = row && row.receipt_token;
    if (!token || !RECEIPT_TOKEN_RE.test(token)) return null;
    return `${String(siteUrl).replace(/\/+$/, '')}/r/${token}`;
  } catch (err) {
    console.warn('[receipt] link not made:', String(err && err.message ? err.message : err).slice(0, 200));
    return null;
  }
}

module.exports = { receiptUrlFor, RECEIPT_TOKEN_RE };
