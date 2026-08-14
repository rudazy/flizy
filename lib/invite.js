/**
 * Invite codes, set-once attribution, and the counting gate.
 *
 * Codes are not user-chosen. Attribution is a recorded fact and increments
 * nothing. A count happens only inside tryCountInvite, which burns the
 * invitee's current E.164 numbers into invite_phone_claims so unlink cannot
 * recycle a SIM for a second credit.
 *
 * Money paths call maybeMarkFirstTx and must not fail if this module cannot
 * write (missing table, lock). Mirror: web/lib/invite.ts. Keep them in sync;
 * test/invite.test.js pins the shared predicates.
 */

const { isUsernameReserved, reservedKey, normalizeUsername } = require('./username');
const { normalizePhoneNumber, isPlausiblePhone } = require('./phone');

/** Same shape as accounts.username: letter first, 3-24 a-z0-9. */
const INVITE_CODE_FORMAT = /^[a-z][a-z0-9]{2,23}$/;
const INVITE_ISSUE_TRIES = 2;

const INVITE_COOKIE = 'flizy_invite';
const INVITE_COOKIE_SRC = 'flizy_invite_src';
const INVITE_COOKIE_MAX_AGE_SEC = 14 * 24 * 60 * 60;

const INVITE_SOURCE = 'invite_link';
const INVITE_SOURCE_CLAIM = 'claim_link';
const INVITE_SOURCES = Object.freeze({
  INVITE_LINK: INVITE_SOURCE,
  CLAIM_LINK: INVITE_SOURCE_CLAIM,
});

function normalizeInviteSource(raw) {
  const s = String(raw || '').trim();
  if (s === INVITE_SOURCE_CLAIM) return INVITE_SOURCE_CLAIM;
  return INVITE_SOURCE;
}

const INVITE_EVENT = Object.freeze({
  ATTRIBUTED: 'ATTRIBUTED',
  ONBOARDED: 'ONBOARDED',
  FIRST_TX: 'FIRST_TX',
  COUNTED: 'COUNTED',
  COUNT_REJECTED: 'COUNT_REJECTED',
});

const QUALIFYING_KINDS = Object.freeze({
  CLAIM_PAYOUT: 'claim_payout',
  OUTBOUND_SEND: 'outbound_send',
});

function isMissingRelation(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    code === 'PGRST202' ||
    /does not exist/i.test(message) ||
    /unknown function/i.test(message) ||
    /could not find the function/i.test(message)
  );
}

function normalizeInviteCode(raw) {
  return normalizeUsername(raw);
}

/**
 * Pull a username out of a typed field. Accepts @name, /i/name,
 * /claim/{token}/name, or ?i=name. Never an account id.
 */
function extractInviteCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const fromInvite = s.match(/\/i\/([a-z][a-z0-9]{2,23})/i);
  if (fromInvite) return normalizeInviteCode(fromInvite[1]);
  const fromClaim = s.match(/\/claim\/[^/]+\/([a-z][a-z0-9]{2,23})(?:[/?#]|$)/i);
  if (fromClaim) return normalizeInviteCode(fromClaim[1]);
  const fromQuery = s.match(/[?&](?:i|invite)=([a-z][a-z0-9]{2,23})/i);
  if (fromQuery) return normalizeInviteCode(fromQuery[1]);
  return normalizeInviteCode(s);
}

/**
 * Typed field wins when it is a real code. Cookie is the fallback for people
 * who opened /i/{code} or a claim that already set it.
 */
function resolveSignupInvite(typed, cookie, cookieSource) {
  const fromField = extractInviteCode(typed);
  if (isInviteCodeFormat(fromField)) {
    return { code: fromField, source: INVITE_SOURCE };
  }
  const fromCookie = normalizeInviteCode(cookie);
  if (isInviteCodeFormat(fromCookie)) {
    return { code: fromCookie, source: normalizeInviteSource(cookieSource) };
  }
  return { code: null, source: INVITE_SOURCE };
}

function isInviteCodeFormat(raw) {
  return INVITE_CODE_FORMAT.test(normalizeInviteCode(raw));
}

/**
 * Whether a qualifying first tx just landed for this account.
 * Pure. Swaps, failed receipts, holds, internal credit and self-deals are out.
 *
 * @param {{
 *   accountId?: string,
 *   kind?: string,
 *   amount?: string|number,
 *   ok?: boolean,
 *   counterpartyAccountId?: string|null,
 *   destinationIsOwnWallet?: boolean,
 * }} p
 */
function isQualifyingFirstTx(p) {
  if (!p || !p.accountId) return false;
  if (p.ok !== true) return false;
  const amount = Number(p.amount);
  if (!Number.isFinite(amount) || amount <= 0) return false;

  if (p.kind === QUALIFYING_KINDS.CLAIM_PAYOUT) {
    if (p.counterpartyAccountId && p.counterpartyAccountId === p.accountId) return false;
    return true;
  }
  if (p.kind === QUALIFYING_KINDS.OUTBOUND_SEND) {
    if (p.destinationIsOwnWallet) return false;
    if (p.counterpartyAccountId && p.counterpartyAccountId === p.accountId) return false;
    return true;
  }
  return false;
}

async function logInviteEvent(supabase, row) {
  try {
    const { error } = await supabase.from('invite_events').insert({
      invitee_account_id: row.inviteeAccountId || null,
      inviter_account_id: row.inviterAccountId || null,
      event_type: row.eventType,
      detail: row.detail || null,
    });
    if (error && !isMissingRelation(error)) {
      console.warn('[invite] event write failed:', error.message);
    }
  } catch (err) {
    console.warn('[invite] event write failed:', err && err.message ? err.message : err);
  }
}

/**
 * Issue one stable code for an account that already has a username.
 * Regenerates on reserved-key hit or unique collision.
 *
 * @returns {Promise<{ ok: true, code: string, created: boolean } | { ok: false, reason: string }>}
 */
async function ensureInviteCode(supabase, accountId) {
  if (!accountId) return { ok: false, reason: 'invalid' };

  const { data: acc, error: accErr } = await supabase
    .from('accounts')
    .select('username')
    .eq('id', accountId)
    .maybeSingle();
  if (accErr) {
    if (isMissingRelation(accErr)) return { ok: false, reason: 'unavailable' };
    throw new Error(`invite username read failed: ${accErr.message}`);
  }
  const code = normalizeInviteCode(acc?.username);
  if (!isInviteCodeFormat(code)) return { ok: false, reason: 'no_username' };

  const { data: existing, error: readErr } = await supabase
    .from('invite_codes')
    .select('code')
    .eq('account_id', accountId)
    .maybeSingle();
  if (readErr) {
    if (isMissingRelation(readErr)) return { ok: false, reason: 'unavailable' };
    throw new Error(`invite code read failed: ${readErr.message}`);
  }
  if (existing?.code === code) return { ok: true, code, created: false };

  if (existing) {
    const { error: upErr } = await supabase
      .from('invite_codes')
      .update({ code })
      .eq('account_id', accountId);
    if (upErr) {
      if (isMissingRelation(upErr)) return { ok: false, reason: 'unavailable' };
      throw new Error(`invite code update failed: ${upErr.message}`);
    }
    return { ok: true, code, created: false };
  }

  const { error: insErr } = await supabase.from('invite_codes').insert({
    account_id: accountId,
    code,
  });
  if (insErr) {
    if (isMissingRelation(insErr)) return { ok: false, reason: 'unavailable' };
    if (String(insErr.code) === '23505') return { ok: true, code, created: false };
    throw new Error(`invite code insert failed: ${insErr.message}`);
  }
  return { ok: true, code, created: true };
}

async function resolveInviterByRef(supabase, slug) {
  const ref = normalizeInviteCode(slug);
  if (!isInviteCodeFormat(ref)) return null;

  const { data: byCode, error: codeErr } = await supabase
    .from('invite_codes')
    .select('account_id, code')
    .eq('code', ref)
    .maybeSingle();
  if (codeErr && !isMissingRelation(codeErr)) {
    throw new Error(`invite ref lookup failed: ${codeErr.message}`);
  }
  if (byCode?.account_id) return byCode;

  const { data: byName, error: nameErr } = await supabase
    .from('accounts')
    .select('id, username')
    .eq('username', ref)
    .maybeSingle();
  if (nameErr && !isMissingRelation(nameErr)) {
    throw new Error(`invite username lookup failed: ${nameErr.message}`);
  }
  if (byName?.id) return { account_id: byName.id, code: normalizeInviteCode(byName.username) };
  return null;
}

/**
 * Record attribution from a public invite code. Set once. Never trusts an
 * inviter id from the client. Missing/invalid code is a no-op.
 *
 * @returns {Promise<{ ok: boolean, reason?: string, attributed?: boolean }>}
 */
async function attributeSignup(supabase, { inviteeAccountId, code, source }) {
  const slug = normalizeInviteCode(code);
  if (!inviteeAccountId || !isInviteCodeFormat(slug)) {
    return { ok: true, attributed: false, reason: 'no_code' };
  }
  const via = normalizeInviteSource(source);

  const { data: existing, error: existErr } = await supabase
    .from('invite_attributions')
    .select('inviter_account_id')
    .eq('invitee_account_id', inviteeAccountId)
    .maybeSingle();
  if (existErr) {
    if (isMissingRelation(existErr)) return { ok: true, attributed: false, reason: 'unavailable' };
    throw new Error(`attribution read failed: ${existErr.message}`);
  }
  if (existing) return { ok: true, attributed: false, reason: 'already' };

  let owned;
  try {
    owned = await resolveInviterByRef(supabase, slug);
  } catch (err) {
    if (isMissingRelation(err)) return { ok: true, attributed: false, reason: 'unavailable' };
    throw err;
  }
  if (!owned?.account_id) return { ok: true, attributed: false, reason: 'unknown_code' };
  if (owned.account_id === inviteeAccountId) {
    return { ok: true, attributed: false, reason: 'self' };
  }

  const { error: insErr } = await supabase.from('invite_attributions').insert({
    invitee_account_id: inviteeAccountId,
    inviter_account_id: owned.account_id,
    invite_code: owned.code,
    source: via,
  });
  if (insErr) {
    if (isMissingRelation(insErr)) return { ok: true, attributed: false, reason: 'unavailable' };
    if (String(insErr.code) === '23505') return { ok: true, attributed: false, reason: 'already' };
    throw new Error(`attribution insert failed: ${insErr.message}`);
  }

  await logInviteEvent(supabase, {
    inviteeAccountId,
    inviterAccountId: owned.account_id,
    eventType: INVITE_EVENT.ATTRIBUTED,
  });
  return { ok: true, attributed: true };
}

async function loadAttribution(supabase, inviteeAccountId) {
  const { data, error } = await supabase
    .from('invite_attributions')
    .select(
      'invitee_account_id, inviter_account_id, invite_code, source, attributed_at, onboarding_completed_at, first_tx_at, counted_at, count_blocked_reason'
    )
    .eq('invitee_account_id', inviteeAccountId)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(`attribution load failed: ${error.message}`);
  }
  return data || null;
}

/**
 * Stamp onboarding when email is verified and username is set. Then try count.
 */
async function maybeMarkOnboarded(supabase, accountId) {
  if (!accountId) return { ok: false, reason: 'invalid' };
  try {
    const { data: acc, error } = await supabase
      .from('accounts')
      .select('email_verified_at, username')
      .eq('id', accountId)
      .maybeSingle();
    if (error) {
      if (isMissingRelation(error)) return { ok: false, reason: 'unavailable' };
      throw new Error(`onboard account read failed: ${error.message}`);
    }
    if (!acc?.email_verified_at || !String(acc.username || '').trim()) {
      return { ok: true, stamped: false, reason: 'not_ready' };
    }

    const attr = await loadAttribution(supabase, accountId);
    if (!attr) return { ok: true, stamped: false, reason: 'unattributed' };
    if (attr.onboarding_completed_at) {
      return tryCountInvite(supabase, accountId);
    }

    const { error: upErr } = await supabase
      .from('invite_attributions')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('invitee_account_id', accountId)
      .is('onboarding_completed_at', null);
    if (upErr) {
      if (isMissingRelation(upErr)) return { ok: false, reason: 'unavailable' };
      throw new Error(`onboard stamp failed: ${upErr.message}`);
    }

    await logInviteEvent(supabase, {
      inviteeAccountId: accountId,
      inviterAccountId: attr.inviter_account_id,
      eventType: INVITE_EVENT.ONBOARDED,
    });
    return tryCountInvite(supabase, accountId);
  } catch (err) {
    console.warn('[invite] onboard hook:', err && err.message ? err.message : err);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Stamp first qualifying tx, then try count. Never throws to the money path.
 */
async function maybeMarkFirstTx(supabase, p) {
  try {
    if (!isQualifyingFirstTx(p)) return { ok: true, stamped: false, reason: 'not_qualifying' };
    const attr = await loadAttribution(supabase, p.accountId);
    if (!attr) return { ok: true, stamped: false, reason: 'unattributed' };
    if (!attr.first_tx_at) {
      const { error: upErr } = await supabase
        .from('invite_attributions')
        .update({ first_tx_at: new Date().toISOString() })
        .eq('invitee_account_id', p.accountId)
        .is('first_tx_at', null);
      if (upErr) {
        if (isMissingRelation(upErr)) return { ok: false, reason: 'unavailable' };
        throw new Error(`first tx stamp failed: ${upErr.message}`);
      }
      await logInviteEvent(supabase, {
        inviteeAccountId: p.accountId,
        inviterAccountId: attr.inviter_account_id,
        eventType: INVITE_EVENT.FIRST_TX,
      });
    }
    return tryCountInvite(supabase, p.accountId);
  } catch (err) {
    console.warn('[invite] first tx hook:', err && err.message ? err.message : err);
    return { ok: false, reason: 'error' };
  }
}

function collectCountablePhones(identities) {
  const lids = new Set();
  for (const row of identities || []) {
    if (row.channel === 'whatsapp' && row.external_id) {
      lids.add(String(row.external_id));
    }
  }
  const phones = [];
  const seen = new Set();
  for (const row of identities || []) {
    const phone = normalizePhoneNumber(row.phone_e164);
    if (!phone || !isPlausiblePhone(phone)) continue;
    if (lids.has(phone)) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);
    phones.push(phone);
  }
  return phones;
}

/**
 * JS twin of try_count_invite. Used when the RPC is missing (tests, unapplied
 * migration). Production prefers the SQL function so the burn and the stamp
 * are one transaction.
 */
async function tryCountInviteLocal(supabase, inviteeAccountId) {
  const attr = await loadAttribution(supabase, inviteeAccountId);
  if (!attr) return { ok: false, reason: 'noop' };
  if (attr.counted_at) return { ok: false, reason: 'noop' };
  if (!attr.onboarding_completed_at || !attr.first_tx_at) {
    return { ok: false, reason: 'not_ready' };
  }

  const { data: reverse } = await supabase
    .from('invite_attributions')
    .select('counted_at')
    .eq('invitee_account_id', attr.inviter_account_id)
    .eq('inviter_account_id', inviteeAccountId)
    .maybeSingle();
  if (reverse?.counted_at) {
    await supabase
      .from('invite_attributions')
      .update({ count_blocked_reason: 'circular' })
      .eq('invitee_account_id', inviteeAccountId)
      .is('count_blocked_reason', null);
    await logInviteEvent(supabase, {
      inviteeAccountId,
      inviterAccountId: attr.inviter_account_id,
      eventType: INVITE_EVENT.COUNT_REJECTED,
      detail: 'circular',
    });
    return { ok: false, reason: 'circular' };
  }

  const { data: identities, error: idErr } = await supabase
    .from('channel_identities')
    .select('channel, external_id, phone_e164')
    .eq('account_id', inviteeAccountId);
  if (idErr) {
    if (isMissingRelation(idErr)) return { ok: false, reason: 'unavailable' };
    throw new Error(`count identities failed: ${idErr.message}`);
  }

  const phones = collectCountablePhones(identities || []);
  if (!phones.length) return { ok: false, reason: 'no_phone' };

  for (const phone of phones) {
    const { data: claimed } = await supabase
      .from('invite_phone_claims')
      .select('invitee_account_id')
      .eq('phone_e164', phone)
      .maybeSingle();
    if (claimed && claimed.invitee_account_id !== inviteeAccountId) {
      await supabase
        .from('invite_attributions')
        .update({ count_blocked_reason: 'phone_spent' })
        .eq('invitee_account_id', inviteeAccountId)
        .is('count_blocked_reason', null);
      await logInviteEvent(supabase, {
        inviteeAccountId,
        inviterAccountId: attr.inviter_account_id,
        eventType: INVITE_EVENT.COUNT_REJECTED,
        detail: 'phone_spent',
      });
      return { ok: false, reason: 'phone_spent' };
    }
    if (!claimed) {
      const { error: burnErr } = await supabase.from('invite_phone_claims').insert({
        phone_e164: phone,
        invitee_account_id: inviteeAccountId,
        attribution_invitee_id: inviteeAccountId,
      });
      if (burnErr && String(burnErr.code) === '23505') {
        const { data: again } = await supabase
          .from('invite_phone_claims')
          .select('invitee_account_id')
          .eq('phone_e164', phone)
          .maybeSingle();
        if (again && again.invitee_account_id !== inviteeAccountId) {
          await supabase
            .from('invite_attributions')
            .update({ count_blocked_reason: 'phone_spent' })
            .eq('invitee_account_id', inviteeAccountId)
            .is('count_blocked_reason', null);
          await logInviteEvent(supabase, {
            inviteeAccountId,
            inviterAccountId: attr.inviter_account_id,
            eventType: INVITE_EVENT.COUNT_REJECTED,
            detail: 'phone_spent',
          });
          return { ok: false, reason: 'phone_spent' };
        }
      } else if (burnErr) {
        if (isMissingRelation(burnErr)) return { ok: false, reason: 'unavailable' };
        throw new Error(`phone claim insert failed: ${burnErr.message}`);
      }
    }
  }

  const { error: countErr } = await supabase
    .from('invite_attributions')
    .update({ counted_at: new Date().toISOString() })
    .eq('invitee_account_id', inviteeAccountId)
    .is('counted_at', null);
  if (countErr) {
    if (isMissingRelation(countErr)) return { ok: false, reason: 'unavailable' };
    throw new Error(`count stamp failed: ${countErr.message}`);
  }

  await logInviteEvent(supabase, {
    inviteeAccountId,
    inviterAccountId: attr.inviter_account_id,
    eventType: INVITE_EVENT.COUNTED,
  });
  return { ok: true };
}

async function tryCountInvite(supabase, inviteeAccountId) {
  if (!inviteeAccountId) return { ok: false, reason: 'noop' };
  try {
    const { data, error } = await supabase.rpc('try_count_invite', {
      p_invitee: inviteeAccountId,
    });
    if (!error && data && typeof data === 'object') {
      return { ok: Boolean(data.ok), reason: data.reason || (data.ok ? undefined : 'noop') };
    }
    if (error && !isMissingRelation(error)) {
      console.warn('[invite] try_count_invite rpc:', error.message);
    }
    return tryCountInviteLocal(supabase, inviteeAccountId);
  } catch (err) {
    console.warn('[invite] try_count_invite:', err && err.message ? err.message : err);
    try {
      return await tryCountInviteLocal(supabase, inviteeAccountId);
    } catch (inner) {
      console.warn('[invite] try_count_invite local:', inner && inner.message ? inner.message : inner);
      return { ok: false, reason: 'error' };
    }
  }
}

async function countedInvitesFor(supabase, inviterAccountId) {
  if (!inviterAccountId) return 0;
  const { data, error } = await supabase
    .from('invite_attributions')
    .select('invitee_account_id, counted_at')
    .eq('inviter_account_id', inviterAccountId);
  if (error) {
    if (isMissingRelation(error)) return 0;
    throw new Error(`invite count read failed: ${error.message}`);
  }
  return (data || []).filter((row) => row.counted_at).length;
}

/**
 * Sender toggle: when on, new claims snapshot this account's invite code.
 * Fail closed to "off" if the column or row is missing.
 */
async function inviteCodeIfAttachEnabled(supabase, accountId) {
  if (!accountId) return null;
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('attach_invite_on_claims')
      .eq('id', accountId)
      .maybeSingle();
    if (error || !data || !data.attach_invite_on_claims) return null;
    const issued = await ensureInviteCode(supabase, accountId);
    return issued.ok ? issued.code : null;
  } catch (err) {
    console.warn('[invite] attach lookup:', err && err.message ? err.message : err);
    return null;
  }
}

async function getInviteSummary(supabase, accountId, siteUrl) {
  const issued = await ensureInviteCode(supabase, accountId);
  if (!issued.ok) return null;
  const counted = await countedInvitesFor(supabase, accountId);
  const base = String(siteUrl || '').replace(/\/$/, '');
  let attachOnClaims = false;
  try {
    const { data } = await supabase
      .from('accounts')
      .select('attach_invite_on_claims')
      .eq('id', accountId)
      .maybeSingle();
    attachOnClaims = Boolean(data && data.attach_invite_on_claims);
  } catch {
    attachOnClaims = false;
  }
  return {
    code: issued.code,
    url: base ? `${base}/i/${issued.code}` : `/i/${issued.code}`,
    counted,
    attachOnClaims,
  };
}

module.exports = {
  INVITE_CODE_FORMAT,
  INVITE_ISSUE_TRIES,
  INVITE_COOKIE,
  INVITE_COOKIE_SRC,
  INVITE_COOKIE_MAX_AGE_SEC,
  INVITE_SOURCE,
  INVITE_SOURCE_CLAIM,
  INVITE_SOURCES,
  normalizeInviteSource,
  INVITE_EVENT,
  QUALIFYING_KINDS,
  normalizeInviteCode,
  extractInviteCode,
  resolveSignupInvite,
  resolveInviterByRef,
  isInviteCodeFormat,
  reservedKey,
  isQualifyingFirstTx,
  ensureInviteCode,
  attributeSignup,
  maybeMarkOnboarded,
  maybeMarkFirstTx,
  tryCountInvite,
  tryCountInviteLocal,
  countedInvitesFor,
  inviteCodeIfAttachEnabled,
  getInviteSummary,
  collectCountablePhones,
};
