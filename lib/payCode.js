/**
 * Pay codes: 9 digits, one per account. Not the @username.
 *
 * Digits only, and that is a security property rather than a style choice. A
 * username must match ^[a-z][a-z0-9]{2,23}$, so a code beginning with a digit
 * can never be a valid username. The old 6-character alphanumeric codes could:
 * lowercased, they were valid usernames, and /pay/{ref} resolves usernames
 * before codes -- so anyone could read a shop's code off its printed sheet,
 * register it as their username, and collect payments meant for that shop.
 * A leading digit removes that overlap by construction.
 *
 * It is also the shape people already know. You hand out the number; the payer
 * reads whose account it is off the confirm screen, the way a bank works.
 *
 * NINE digits, not ten, and that is load-bearing. lib/phone.js reads anything
 * from PHONE_MIN_DIGITS (10) upward as a phone number, so a nine-digit code
 * sits below the floor and can never be mistaken for one -- in any country, with
 * no rule for anyone to remember. Ten digits would have collided with bare
 * mobile numbers in the US, India, Kenya, Ghana and South Africa, and would also
 * have looked exactly like a Nigerian NUBAN, which invites someone to paste a
 * real bank account number in here. test/payCode.test.js pins code length below
 * the phone floor so neither can drift into the other.
 *
 * Stored and compared as TEXT, never a number -- 0123456789 must keep its
 * leading zero or it stops matching.
 *
 * Mirror: web/lib/payCode.ts. test/payCode.test.js pins the format.
 */

const crypto = require('crypto');
const { normalizeUsername } = require('./username');

const PAY_CODE_ALPHABET = '0123456789';
const PAY_CODE_LENGTH = 9;
const PAY_CODE_FORMAT = /^[0-9]{9}$/;
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

/**
 * Anything a human might type or paste, reduced to the stored form.
 * Strips the grouping this is displayed with ("012 345 678") and any stray
 * punctuation, so a code read off a counter still matches.
 */
function normalizePayCode(raw) {
  return String(raw || '')
    .trim()
    .replace(/[^0-9]/g, '');
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

  // A code is never rotated -- printed paper depends on it -- with exactly one
  // exception: a stored code that cannot satisfy the current format is already
  // unusable, so it is replaced rather than kept. That makes a format change
  // self-healing on first read, and it closes a real trap: account_id is the
  // primary key, so inserting over a stale row would fail 23505 every attempt
  // and exhaust the loop, silently leaving the account with no pay code.
  //
  // Note what this means: changing PAY_CODE_FORMAT re-mints every code in the
  // product. That is a deliberate, owner-level decision, never a tidy-up.
  const replacing = Boolean(existing?.code);

  for (let i = 0; i < PAY_CODE_ISSUE_TRIES; i += 1) {
    const code = mintPayCode();
    const { error: writeErr } = replacing
      ? await supabase.from('pay_codes').update({ code }).eq('account_id', accountId)
      : await supabase.from('pay_codes').insert({ account_id: accountId, code });
    if (!writeErr) return { ok: true, code, created: !replacing };
    if (isMissingRelation(writeErr)) return { ok: false, reason: 'unavailable' };
    if (String(writeErr.code) === '23505') continue;
    throw new Error(`pay code write failed: ${writeErr.message}`);
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

/**
 * The two URLs a pay identity needs, and why they are not the same URL.
 *
 * qrUrl is the one that gets printed and taped to a counter, so it routes on
 * the pay code -- a permanent per-account id -- and never on the username,
 * which can change. Paper cannot be recalled: a QR keyed on a name that later
 * moves is either dead or, if that name is ever reissued, pointing at someone
 * else. It carries no name at all, because the printed sheet shows no name --
 * the payer reads whose account it is off the confirm screen, live.
 *
 * shareUrl is typed, pasted and read aloud, so it stays the pretty username
 * form. Nothing is printed from it, and a renamed account keeps resolving.
 *
 * Mirrored in web/lib/payCode.ts; test/payUrls.test.js pins both to the same
 * vectors.
 *
 * @param {string} siteUrl
 * @param {string} code permanent pay code
 * @param {string|null} username current username, may be null
 * @returns {{ shareUrl: string, qrUrl: string }}
 */
function buildPayUrls(siteUrl, code, username) {
  const base = String(siteUrl || '').replace(/\/$/, '');
  const name = normalizeUsername(username || '') || null;
  const routeCode = String(code || '').trim() || name;
  const slug = name || routeCode;
  // /pay/c/{code} resolves the pay code ONLY. /pay/{ref} accepts a username
  // too, and the namespaces overlap, so pointing printed paper there would let
  // anyone read a shop's code off its QR, register it as a username, and
  // quietly collect payments meant for the shop.
  //
  // No name is carried in the URL: the printed sheet shows the code alone, so
  // there is no printed name for a scan to disagree with. The payer reads whose
  // account it is off the confirm screen, live -- the bank-account model.
  const qrPath = routeCode ? `/pay/c/${routeCode}` : '';
  // An account mid-issue has no code yet, so the QR falls back to the name
  // route. A link that resolves beats none, and it is replaced the moment a
  // code exists -- nothing has been printed from it yet.
  const qrFallback = !routeCode || routeCode === name;
  return {
    shareUrl: slug ? (base ? `${base}/pay/${slug}` : `/pay/${slug}`) : '',
    qrUrl: qrFallback
      ? slug
        ? base
          ? `${base}/pay/${slug}`
          : `/pay/${slug}`
        : ''
      : base
        ? `${base}${qrPath}`
        : qrPath,
  };
}

async function getPaySummary(supabase, accountId, siteUrl) {
  const issued = await ensurePayCode(supabase, accountId);
  if (!issued.ok) return null;
  const { data: acc } = await supabase
    .from('accounts')
    .select('username, display_name')
    .eq('id', accountId)
    .maybeSingle();
  const urls = buildPayUrls(siteUrl, issued.code, acc?.username || null);
  return {
    code: issued.code,
    // url stays the shareable username form. qrUrl is what gets printed.
    url: urls.shareUrl,
    qrUrl: urls.qrUrl,
    username: acc?.username || null,
    displayName: acc?.display_name || null,
  };
}

module.exports = {
  buildPayUrls,
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
