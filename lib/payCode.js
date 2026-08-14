/**
 * Short pay codes. One per account. Not the @username.
 * Alphabet omits 0/O/1/I/L so a stall can read it aloud.
 * Mirror: web/lib/payCode.ts. test/payCode.test.js pins the format.
 */

const crypto = require('crypto');
const { normalizeUsername } = require('./username');

const PAY_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PAY_CODE_LENGTH = 6;
const PAY_CODE_FORMAT = /^[2-9A-HJ-NP-Z]{6}$/;
const PAY_CODE_ISSUE_TRIES = 8;

function isMissingRelation(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /does not exist/i.test(message)
  );
}

function normalizePayCode(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^2-9A-HJ-NP-Z]/g, '');
}

function isPayCodeFormat(raw) {
  return PAY_CODE_FORMAT.test(normalizePayCode(raw));
}

function mintPayCode() {
  let out = '';
  for (let i = 0; i < PAY_CODE_LENGTH; i += 1) {
    out += PAY_CODE_ALPHABET[crypto.randomInt(PAY_CODE_ALPHABET.length)];
  }
  return out;
}

async function ensurePayCode(supabase, accountId) {
  if (!accountId) return { ok: false, reason: 'invalid' };

  const { data: existing, error: readErr } = await supabase
    .from('pay_codes')
    .select('code')
    .eq('account_id', accountId)
    .maybeSingle();
  if (readErr) {
    if (isMissingRelation(readErr)) return { ok: false, reason: 'unavailable' };
    throw new Error(`pay code read failed: ${readErr.message}`);
  }
  if (existing?.code && isPayCodeFormat(existing.code)) {
    return { ok: true, code: existing.code, created: false };
  }

  for (let i = 0; i < PAY_CODE_ISSUE_TRIES; i += 1) {
    const code = mintPayCode();
    const { error: insErr } = await supabase.from('pay_codes').insert({
      account_id: accountId,
      code,
    });
    if (!insErr) return { ok: true, code, created: true };
    if (isMissingRelation(insErr)) return { ok: false, reason: 'unavailable' };
    if (String(insErr.code) === '23505') continue;
    throw new Error(`pay code insert failed: ${insErr.message}`);
  }
  return { ok: false, reason: 'exhausted' };
}

async function resolvePayCode(supabase, raw) {
  const code = normalizePayCode(raw);
  if (!isPayCodeFormat(code)) return null;
  const { data, error } = await supabase
    .from('pay_codes')
    .select('account_id, code')
    .eq('code', code)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(`pay code lookup failed: ${error.message}`);
  }
  if (!data?.account_id) return null;
  const { data: acc, error: accErr } = await supabase
    .from('accounts')
    .select('username, display_name')
    .eq('id', data.account_id)
    .maybeSingle();
  if (accErr && !isMissingRelation(accErr)) {
    throw new Error(`pay code account read failed: ${accErr.message}`);
  }
  return {
    accountId: data.account_id,
    code: data.code,
    username: acc?.username || null,
    displayName: acc?.display_name || null,
  };
}

async function resolvePayRef(supabase, raw) {
  const asUser = normalizeUsername(raw);
  if (asUser && /^[a-z][a-z0-9]{2,23}$/.test(asUser)) {
    const { data: acc, error } = await supabase
      .from('accounts')
      .select('id, username, display_name')
      .eq('username', asUser)
      .maybeSingle();
    if (error && !isMissingRelation(error)) {
      throw new Error(`pay username lookup failed: ${error.message}`);
    }
    if (acc?.id) {
      const { data: pay } = await supabase
        .from('pay_codes')
        .select('code')
        .eq('account_id', acc.id)
        .maybeSingle();
      return {
        accountId: acc.id,
        code: pay?.code || null,
        username: acc.username || asUser,
        displayName: acc.display_name || null,
      };
    }
  }
  return resolvePayCode(supabase, raw);
}

async function hasPaidMerchantBefore(supabase, payerAccountId, toAddress) {
  if (!payerAccountId || !toAddress) return false;
  const addr = String(toAddress).toLowerCase();
  const { data, error } = await supabase
    .from('transfers')
    .select('id')
    .eq('account_id', payerAccountId)
    .eq('status', 'confirmed')
    .ilike('to_address', addr)
    .limit(1);
  if (error) {
    if (isMissingRelation(error)) return false;
    throw new Error(`pay history read failed: ${error.message}`);
  }
  return Boolean(data && data.length);
}

async function isSavedMerchant(supabase, payerAccountId, toAddress) {
  if (!payerAccountId || !toAddress) return false;
  const addr = String(toAddress);
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('id')
    .eq('account_id', payerAccountId)
    .ilike('address', addr)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return false;
    throw new Error(`pay trusted read failed: ${error.message}`);
  }
  return Boolean(data);
}

async function resolveFlizyPayDestination(supabase, raw, payerAccountId) {
  const found = await resolvePayRef(supabase, raw);
  if (!found) return { found: false };
  if (payerAccountId && found.accountId === payerAccountId) {
    return { found: true, self: true };
  }
  const { data: acc, error } = await supabase
    .from('accounts')
    .select('agent_wallet_address')
    .eq('id', found.accountId)
    .maybeSingle();
  if (error && !isMissingRelation(error)) {
    throw new Error(`pay dest wallet read failed: ${error.message}`);
  }
  const address = acc?.agent_wallet_address;
  if (!address) return { found: true, noWallet: true };
  const label = found.username
    ? `@${found.username}`
    : found.displayName || found.code;
  return {
    found: true,
    address,
    label,
    displayName: found.displayName || null,
    accountId: found.accountId,
  };
}

async function getPaySummary(supabase, accountId, siteUrl) {
  const issued = await ensurePayCode(supabase, accountId);
  if (!issued.ok) return null;
  const base = String(siteUrl || '').replace(/\/$/, '');
  const { data: acc } = await supabase
    .from('accounts')
    .select('username, display_name')
    .eq('id', accountId)
    .maybeSingle();
  const slug = acc?.username || issued.code;
  return {
    code: issued.code,
    url: base ? `${base}/pay/${slug}` : `/pay/${slug}`,
    username: acc?.username || null,
    displayName: acc?.display_name || null,
  };
}

module.exports = {
  PAY_CODE_ALPHABET,
  PAY_CODE_LENGTH,
  PAY_CODE_FORMAT,
  PAY_CODE_ISSUE_TRIES,
  normalizePayCode,
  isPayCodeFormat,
  mintPayCode,
  ensurePayCode,
  resolvePayCode,
  resolvePayRef,
  resolveFlizyPayDestination,
  hasPaidMerchantBefore,
  isSavedMerchant,
  getPaySummary,
};
