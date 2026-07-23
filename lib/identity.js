/**
 * Account identity + WhatsApp link codes (Phase 1).
 * Observed wa_sender_id (often LID) is the lookup key for the bot.
 * Optional wa_phone_e164 is the join key for claims/requests only.
 */

const crypto = require('crypto');
const { getSupabase } = require('./supabase');
const { config } = require('./config');
const { normalizePhoneNumber, isPlausiblePhone } = require('./phone');

function normalizeSenderId(raw) {
  return String(raw || '')
    .split('@')[0]
    .trim()
    .replace(/^\+/, '');
}

/**
 * Store normalized phone on identity (fill or refresh). Does not change wa_sender_id.
 * @param {string} waSenderId
 * @param {string} phoneRaw
 * @returns {Promise<string|null>} normalized phone stored, or null if invalid
 */
async function setIdentityPhone(waSenderId, phoneRaw) {
  const sid = normalizeSenderId(waSenderId);
  const phone = normalizePhoneNumber(phoneRaw);
  if (!sid || !phone || !isPlausiblePhone(phone)) return null;

  const supabase = getSupabase();
  const { error } = await supabase
    .from('whatsapp_identities')
    .update({ wa_phone_e164: phone })
    .eq('wa_sender_id', sid);
  if (error) throw new Error(`identity phone update failed: ${error.message}`);
  return phone;
}

/**
 * Load account by WhatsApp sender id observed by the bot.
 * @param {string} waSenderId
 */
async function getAccountByWaSender(waSenderId) {
  const supabase = getSupabase();
  const sid = normalizeSenderId(waSenderId);
  const { data, error } = await supabase
    .from('whatsapp_identities')
    .select('id, account_id, wa_sender_id, wa_phone_e164, accounts(*)')
    .eq('wa_sender_id', sid)
    .maybeSingle();

  if (error) throw new Error(`identity lookup failed: ${error.message}`);
  if (!data) return null;

  return {
    identity: {
      id: data.id,
      wa_sender_id: data.wa_sender_id,
      wa_phone_e164: data.wa_phone_e164,
      account_id: data.account_id,
    },
    account: data.accounts,
  };
}

/**
 * Ensure legacy users row still works: create account + identity if missing.
 * Bridges Phase 0 ledger users into accounts without breaking sends.
 * @param {string} waSenderId
 */
async function getOrCreateAccountForSender(waSenderId) {
  const sid = normalizeSenderId(waSenderId);
  const existing = await getAccountByWaSender(sid);
  if (existing) return { ...existing, isNew: false };

  const supabase = getSupabase();

  // Prefer linking to legacy users row if present
  const { data: legacy } = await supabase
    .from('users')
    .select('id, phone, balance_eth, is_admin, account_id, wallet_address')
    .eq('phone', sid)
    .maybeSingle();

  let accountId = legacy?.account_id || null;

  if (!accountId) {
    const { data: account, error: accErr } = await supabase
      .from('accounts')
      .insert({
        is_admin: Boolean(legacy?.is_admin),
        balance_eth: legacy?.balance_eth ?? 0,
        agent_wallet_address: legacy?.wallet_address || null,
      })
      .select('*')
      .single();
    if (accErr) throw new Error(`account create failed: ${accErr.message}`);
    accountId = account.id;

    if (legacy?.id) {
      await supabase.from('users').update({ account_id: accountId }).eq('id', legacy.id);
    }
  }

  const { data: identity, error: idErr } = await supabase
    .from('whatsapp_identities')
    .insert({
      account_id: accountId,
      wa_sender_id: sid,
    })
    .select('*')
    .single();

  if (idErr) {
    // Race: another insert won
    if (idErr.code === '23505') {
      const raced = await getAccountByWaSender(sid);
      if (raced) return { ...raced, isNew: false };
    }
    throw new Error(`identity create failed: ${idErr.message}`);
  }

  const { data: account, error: fetchErr } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', accountId)
    .single();
  if (fetchErr) throw new Error(fetchErr.message);

  return {
    identity,
    account,
    isNew: true,
  };
}

/**
 * Create a one-time link code for an account (site).
 * @param {string} accountId
 * @returns {Promise<{ code: string, expiresAt: string, waDeepLink: string }>}
 */
async function createLinkCode(accountId) {
  const supabase = getSupabase();
  const code = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
  const expiresAt = new Date(Date.now() + config.linkCodeTtlMs).toISOString();

  const { error } = await supabase.from('link_codes').insert({
    account_id: accountId,
    code,
    expires_at: expiresAt,
  });
  if (error) throw new Error(`link code create failed: ${error.message}`);

  const bot = config.botWhatsAppNumber || '';
  const prefill = encodeURIComponent(`flizy link ${code}`);
  const waDeepLink = bot
    ? `https://wa.me/${bot}?text=${prefill}`
    : `https://wa.me/?text=${prefill}`;

  return { code, expiresAt, waDeepLink };
}

/**
 * Bind observed WhatsApp sender to the account that owns the code. Burns the code.
 * @param {string} waSenderId  observed id (often LID); remains source of truth
 * @param {string} codeRaw
 * @param {string} [waPhone]  real phone digits when known from WhatsApp context
 */
async function consumeLinkCode(waSenderId, codeRaw, waPhone) {
  const supabase = getSupabase();
  const sid = normalizeSenderId(waSenderId);
  const phone =
    waPhone && isPlausiblePhone(waPhone) ? normalizePhoneNumber(waPhone) : null;
  const code = String(codeRaw || '')
    .trim()
    .toUpperCase();

  const { data: row, error } = await supabase
    .from('link_codes')
    .select('*')
    .eq('code', code)
    .is('used_at', null)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) return { ok: false, reason: 'invalid' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  // One WhatsApp id -> one account. A valid site link code is deliberate bind/rebind.
  const existing = await getAccountByWaSender(sid);
  const phonePatch = phone ? { wa_phone_e164: phone } : {};

  if (!existing) {
    const { error: linkErr } = await supabase.from('whatsapp_identities').insert({
      account_id: row.account_id,
      wa_sender_id: sid,
      ...phonePatch,
    });
    if (linkErr) {
      if (linkErr.code === '23505') {
        // Race: re-read and rebind below
        const raced = await getAccountByWaSender(sid);
        if (raced && raced.account.id !== row.account_id) {
          const { error: moveErr } = await supabase
            .from('whatsapp_identities')
            .update({
              account_id: row.account_id,
              linked_at: new Date().toISOString(),
              ...phonePatch,
            })
            .eq('wa_sender_id', sid);
          if (moveErr) throw new Error(moveErr.message);
        } else if (phone) {
          await setIdentityPhone(sid, phone);
        }
      } else {
        throw new Error(linkErr.message);
      }
    }
  } else if (existing.account.id !== row.account_id) {
    // Move identity from auto-created/bot account onto the site account that issued the code
    const { error: moveErr } = await supabase
      .from('whatsapp_identities')
      .update({
        account_id: row.account_id,
        linked_at: new Date().toISOString(),
        ...phonePatch,
      })
      .eq('wa_sender_id', sid);
    if (moveErr) throw new Error(moveErr.message);
  } else if (phone) {
    await setIdentityPhone(sid, phone);
  }

  // Keep legacy users.phone row pointing at the site account when present
  await supabase
    .from('users')
    .update({ account_id: row.account_id })
    .eq('phone', sid);

  const { error: burnErr } = await supabase
    .from('link_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('used_at', null);
  if (burnErr) throw new Error(burnErr.message);

  const bound = await getAccountByWaSender(sid);
  return { ok: true, account: bound?.account, identity: bound?.identity, rebound: Boolean(existing) };
}

/**
 * Create a bare account (site signup stub). No custody yet.
 */
async function createAccountStub(displayName) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .insert({
      display_name: displayName || null,
      agent_wallet_address: null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = {
  normalizeSenderId,
  setIdentityPhone,
  getAccountByWaSender,
  getOrCreateAccountForSender,
  createLinkCode,
  consumeLinkCode,
  createAccountStub,
};
