/**
 * Emails that can unlock email claims for an account.
 *
 * Always includes accounts.email (registration). Additional rows in
 * account_emails count only when verified_at is set.
 */

const { getSupabase } = require('./supabase');
const { normalizeEmail, isValidEmail, parseEmail } = require('./email');

/**
 * @param {string} accountId
 * @returns {Promise<string[]>} normalized claimable emails
 */
async function listClaimableEmailsForAccount(accountId) {
  if (!accountId) return [];
  const supabase = getSupabase();
  const emails = [];

  const { data: acc, error: aErr } = await supabase
    .from('accounts')
    .select('email')
    .eq('id', accountId)
    .maybeSingle();
  if (aErr) throw new Error(aErr.message);
  const primary = parseEmail(acc?.email);
  if (primary) emails.push(primary);

  const { data: rows, error: eErr } = await supabase
    .from('account_emails')
    .select('email, verified_at')
    .eq('account_id', accountId)
    .not('verified_at', 'is', null);
  if (eErr) {
    // Table may not exist until migration; degrade open for primary only.
    if (String(eErr.message || '').includes('account_emails') || eErr.code === '42P01') {
      return emails;
    }
    throw new Error(eErr.message);
  }
  for (const row of rows || []) {
    const e = parseEmail(row.email);
    if (e && !emails.includes(e)) emails.push(e);
  }
  return emails;
}

/**
 * All emails on the account for dashboard (primary + secondaries with status).
 * @param {string} accountId
 */
async function listAccountEmails(accountId) {
  if (!accountId) return { primary: null, additional: [] };
  const supabase = getSupabase();
  const { data: acc, error: aErr } = await supabase
    .from('accounts')
    .select('email')
    .eq('id', accountId)
    .maybeSingle();
  if (aErr) throw new Error(aErr.message);
  const primary = parseEmail(acc?.email);

  let additional = [];
  const { data: rows, error: eErr } = await supabase
    .from('account_emails')
    .select('id, email, verified_at, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (eErr) {
    if (String(eErr.message || '').includes('account_emails') || eErr.code === '42P01') {
      return { primary, additional: [] };
    }
    throw new Error(eErr.message);
  }
  additional = (rows || []).map((r) => ({
    id: r.id,
    email: normalizeEmail(r.email),
    verified: Boolean(r.verified_at),
    verifiedAt: r.verified_at || null,
    createdAt: r.created_at || null,
  }));
  return { primary, additional };
}

/**
 * Find the account that owns this email for claim notify (primary or verified secondary).
 * @param {string} rawEmail
 * @returns {Promise<string|null>} account id
 */
async function findAccountIdByEmail(rawEmail) {
  const email = parseEmail(rawEmail);
  if (!email) return null;
  const supabase = getSupabase();

  const { data: acc, error: aErr } = await supabase
    .from('accounts')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (aErr) throw new Error(aErr.message);
  if (acc?.id) return acc.id;

  const { data: row, error: eErr } = await supabase
    .from('account_emails')
    .select('account_id')
    .eq('email', email)
    .not('verified_at', 'is', null)
    .maybeSingle();
  if (eErr) {
    if (String(eErr.message || '').includes('account_emails') || eErr.code === '42P01') {
      return null;
    }
    throw new Error(eErr.message);
  }
  return row?.account_id || null;
}

/**
 * Add a secondary email (unverified). Claim matching ignores it until verified.
 * @param {string} accountId
 * @param {string} rawEmail
 */
async function addSecondaryEmail(accountId, rawEmail) {
  const email = parseEmail(rawEmail);
  if (!email) {
    const err = new Error('Invalid email address.');
    err.code = 'EMAIL_INVALID';
    throw err;
  }
  if (!isValidEmail(email)) {
    const err = new Error('Invalid email address.');
    err.code = 'EMAIL_INVALID';
    throw err;
  }

  const supabase = getSupabase();

  const { data: self, error: sErr } = await supabase
    .from('accounts')
    .select('email')
    .eq('id', accountId)
    .maybeSingle();
  if (sErr) throw new Error(sErr.message);
  if (parseEmail(self?.email) === email) {
    const err = new Error('That is already your registration email.');
    err.code = 'EMAIL_IS_PRIMARY';
    throw err;
  }

  // Taken as someone else's primary
  const { data: takenPrimary, error: tErr } = await supabase
    .from('accounts')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (tErr) throw new Error(tErr.message);
  if (takenPrimary?.id && takenPrimary.id !== accountId) {
    const err = new Error('That email is already registered to another Flizy account.');
    err.code = 'EMAIL_TAKEN';
    throw err;
  }

  const { data, error } = await supabase
    .from('account_emails')
    .insert({
      account_id: accountId,
      email,
      verified_at: null,
    })
    .select('id, email, verified_at, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      const err = new Error('That email is already on a Flizy account.');
      err.code = 'EMAIL_TAKEN';
      throw err;
    }
    throw new Error(error.message);
  }
  return {
    id: data.id,
    email: normalizeEmail(data.email),
    verified: Boolean(data.verified_at),
    verifiedAt: data.verified_at || null,
    createdAt: data.created_at || null,
  };
}

/**
 * Mark a secondary email verified (caller must have proven ownership).
 * Used by future magic-link verification; also available for admin/tests.
 * @param {string} accountId
 * @param {string} emailId row id
 */
async function markSecondaryEmailVerified(accountId, emailId) {
  const supabase = getSupabase();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('account_emails')
    .update({ verified_at: now })
    .eq('id', emailId)
    .eq('account_id', accountId)
    .select('id, email, verified_at, created_at')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const err = new Error('Email not found on this account.');
    err.code = 'EMAIL_NOT_FOUND';
    throw err;
  }
  return {
    id: data.id,
    email: normalizeEmail(data.email),
    verified: true,
    verifiedAt: data.verified_at,
    createdAt: data.created_at,
  };
}

/**
 * Remove a secondary email (primary cannot be removed here).
 * @param {string} accountId
 * @param {string} emailId
 */
async function removeSecondaryEmail(accountId, emailId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('account_emails')
    .delete()
    .eq('id', emailId)
    .eq('account_id', accountId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) {
    const err = new Error('Email not found on this account.');
    err.code = 'EMAIL_NOT_FOUND';
    throw err;
  }
  return { ok: true };
}

module.exports = {
  listClaimableEmailsForAccount,
  listAccountEmails,
  findAccountIdByEmail,
  addSecondaryEmail,
  markSecondaryEmailVerified,
  removeSecondaryEmail,
};
