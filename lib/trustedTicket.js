/**
 * Carrying an address from a chat-started add to the site.
 *
 * Chat may not grant a payout destination, so `add wallet 0x...` and the
 * post-payment "save this merchant" both stop short of writing and hand the
 * person a link instead. The problem that creates is retyping: in the merchant
 * case the owner has never seen that address and cannot retype it. A ticket
 * carries it across.
 *
 * **A ticket is not a credential.** Redeeming one prefills the add form. The
 * account password is still required to complete the add, on the same route and
 * the same gate as any other add. So a stolen code grants nothing: the worst it
 * does is show an address to somebody who already has the session, and it is
 * bound to the account that minted it, so it cannot prefill anyone else's form.
 *
 * Shaped after link codes on purpose, because that is the product's existing
 * answer to "carry something from a chat message to a browser", and a second
 * shape would be a second thing to get wrong. The code generation follows
 * lib/linkCode.js and the single-use redemption follows consumeLinkCode in
 * lib/identity.js. Ten minutes, single use, one account.
 */

const crypto = require('crypto');
const { getSupabase } = require('./supabase');
const { config } = require('./config');

/** Ten minutes. Long enough to switch device, short enough not to linger. */
const TICKET_TTL_MS = 10 * 60 * 1000;

/** Same shape as link codes: no letters that read as digits. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/**
 * Drawn from crypto, the same source lib/linkCode.js uses.
 *
 * A ticket is not a credential, so a guessed code grants nothing on its own.
 * That is an argument for the weaker source being survivable, not for choosing
 * it: the next reader copies this function before they read the paragraph
 * explaining why it was allowed to be weak. The alphabet is 32 characters and
 * 256 divides evenly by 32, so the modulo carries no bias.
 */
function generateTicketCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function normalizeTicketCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * Mint a ticket for an address the person asked to add from chat.
 *
 * @param {string} accountId
 * @param {string} address checksummed 0x
 * @param {string} [label]
 * @returns {Promise<{ code: string, url: string, expiresAt: string }>}
 */
async function createTrustedAddTicket(accountId, address, label = '') {
  const supabase = getSupabase();
  const code = generateTicketCode();
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS).toISOString();

  const { error } = await supabase.from('trusted_add_tickets').insert({
    account_id: accountId,
    address,
    label: label || '',
    code,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`trusted ticket create failed: ${error.message}`);

  const base = String(config.siteUrl || '').replace(/\/+$/, '');
  return {
    code,
    url: `${base}/dashboard/account?add=${code}`,
    expiresAt,
  };
}

/**
 * Read a ticket for the account redeeming it.
 *
 * Does not consume it and does not add anything. The caller is the site, which
 * uses this only to prefill, and still requires the password before writing.
 *
 * Bound to `accountId`: a code minted for one account cannot prefill another's
 * form even if it leaks.
 *
 * @returns {Promise<{ ok: true, address: string, label: string }
 *   | { ok: false, reason: 'invalid' | 'used' | 'expired' }>}
 */
async function readTrustedAddTicket(accountId, codeRaw) {
  const code = normalizeTicketCode(codeRaw);
  if (!code) return { ok: false, reason: 'invalid' };

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('trusted_add_tickets')
    .select('id, address, label, expires_at, used_at')
    .eq('account_id', accountId)
    .eq('code', code)
    .maybeSingle();
  if (error) throw new Error(`trusted ticket read failed: ${error.message}`);

  if (!data) return { ok: false, reason: 'invalid' };
  if (data.used_at) return { ok: false, reason: 'used' };
  if (new Date(data.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  return { ok: true, address: data.address, label: data.label || '' };
}

/**
 * Mark a ticket spent, after the add it carried has succeeded.
 *
 * Separate from the read so a failed add does not burn the ticket and force the
 * person back to chat to start again.
 */
async function consumeTrustedAddTicket(accountId, codeRaw) {
  const code = normalizeTicketCode(codeRaw);
  if (!code) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from('trusted_add_tickets')
    .update({ used_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('code', code)
    .is('used_at', null);
  if (error) throw new Error(`trusted ticket consume failed: ${error.message}`);
}

module.exports = {
  TICKET_TTL_MS,
  generateTicketCode,
  normalizeTicketCode,
  createTrustedAddTicket,
  readTrustedAddTicket,
  consumeTrustedAddTicket,
};
