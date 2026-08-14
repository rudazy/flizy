/**
 * Invite codes, set-once attribution, and the counting gate (web mirror).
 *
 * Kept in sync with lib/invite.js. Vercel Root Directory is web, so ../lib
 * is never uploaded. test/invite.test.js pins the shared predicates.
 */

import { isUsernameReserved, reservedKey, normalizeUsername } from './username.ts';

export const INVITE_CODE_FORMAT = /^[a-z][a-z0-9]{2,23}$/;
export const INVITE_ISSUE_TRIES = 2;

export const INVITE_COOKIE = 'flizy_invite';
export const INVITE_COOKIE_SRC = 'flizy_invite_src';
export const INVITE_COOKIE_MAX_AGE_SEC = 14 * 24 * 60 * 60;

export const INVITE_SOURCE = 'invite_link';
export const INVITE_SOURCE_CLAIM = 'claim_link';
export const INVITE_SOURCES = Object.freeze({
  INVITE_LINK: INVITE_SOURCE,
  CLAIM_LINK: INVITE_SOURCE_CLAIM,
});

export function normalizeInviteSource(raw: unknown): string {
  const s = String(raw || '').trim();
  if (s === INVITE_SOURCE_CLAIM) return INVITE_SOURCE_CLAIM;
  return INVITE_SOURCE;
}

export const INVITE_EVENT = Object.freeze({
  ATTRIBUTED: 'ATTRIBUTED',
  ONBOARDED: 'ONBOARDED',
  FIRST_TX: 'FIRST_TX',
  COUNTED: 'COUNTED',
  COUNT_REJECTED: 'COUNT_REJECTED',
});

export const QUALIFYING_KINDS = Object.freeze({
  CLAIM_PAYOUT: 'claim_payout',
  OUTBOUND_SEND: 'outbound_send',
  SWAP: 'swap',
  BUY: 'buy',
  SELL: 'sell',
  ADD_LIQUIDITY: 'add_liquidity',
  REMOVE_LIQUIDITY: 'remove_liquidity',
});

const QUALIFYING_KIND_SET = new Set<string>(Object.values(QUALIFYING_KINDS));

// `from` returns any on purpose: a structural SupabaseClient check recurses
// through PostgREST generics until tsc bails. Same reason as username.ts.
type InviteClient = {
  from: (table: string) => any;
  rpc?: (...args: any[]) => any;
};

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
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

export function normalizeInviteCode(raw: unknown): string {
  return normalizeUsername(raw);
}

/** @name, /i/name, /claim/{token}/name, or ?i=name. Never an account id. */
export function extractInviteCode(raw: unknown): string {
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

/** Typed field wins when valid. Cookie is the fallback. */
export function resolveSignupInvite(
  typed: unknown,
  cookie: unknown,
  cookieSource?: unknown
): { code: string | null; source: string } {
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

export function isInviteCodeFormat(raw: unknown): boolean {
  return INVITE_CODE_FORMAT.test(normalizeInviteCode(raw));
}

export function isQualifyingFirstTx(p: {
  accountId?: string;
  kind?: string;
  amount?: string | number;
  ok?: boolean;
  counterpartyAccountId?: string | null;
  destinationIsOwnWallet?: boolean;
}): boolean {
  if (!p || !p.accountId) return false;
  if (p.ok !== true) return false;
  return QUALIFYING_KIND_SET.has(String(p.kind || ''));
}

function normalizePhoneNumber(raw: unknown): string {
  const head = String(raw || '')
    .split('@')[0]
    .trim();
  if (/[a-z]/i.test(head)) return '';
  let d = head.replace(/^\+/, '').replace(/\D/g, '');
  d = d.replace(/^0+/, '');
  return d;
}

function isPlausiblePhone(digits: string): boolean {
  const d = normalizePhoneNumber(digits);
  return d.length >= 10 && d.length <= 15;
}

export function collectCountablePhones(
  identities: Array<{ channel?: string; external_id?: string; phone_e164?: string | null }>
): string[] {
  const lids = new Set<string>();
  for (const row of identities || []) {
    if (row.channel === 'whatsapp' && row.external_id) lids.add(String(row.external_id));
  }
  const phones: string[] = [];
  const seen = new Set<string>();
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

async function logInviteEvent(
  supabase: InviteClient,
  row: {
    inviteeAccountId?: string | null;
    inviterAccountId?: string | null;
    eventType: string;
    detail?: string | null;
  }
) {
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
    console.warn('[invite] event write failed:', err instanceof Error ? err.message : err);
  }
}

export async function ensureInviteCode(
  supabase: InviteClient,
  accountId: string
): Promise<{ ok: true; code: string; created: boolean } | { ok: false; reason: string }> {
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

export async function resolveInviterByRef(
  supabase: InviteClient,
  slug: unknown
): Promise<{ account_id: string; code: string } | null> {
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

export async function attributeSignup(
  supabase: InviteClient,
  p: { inviteeAccountId: string; code: string | null; source?: string | null }
): Promise<{ ok: boolean; reason?: string; attributed?: boolean }> {
  const slug = normalizeInviteCode(p.code);
  if (!p.inviteeAccountId || !isInviteCodeFormat(slug)) {
    return { ok: true, attributed: false, reason: 'no_code' };
  }
  const via = normalizeInviteSource(p.source);

  const { data: existing, error: existErr } = await supabase
    .from('invite_attributions')
    .select('inviter_account_id')
    .eq('invitee_account_id', p.inviteeAccountId)
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
    if (isMissingRelation(err instanceof Error ? err : null)) {
      return { ok: true, attributed: false, reason: 'unavailable' };
    }
    throw err;
  }
  if (!owned?.account_id) return { ok: true, attributed: false, reason: 'unknown_code' };
  if (owned.account_id === p.inviteeAccountId) {
    return { ok: true, attributed: false, reason: 'self' };
  }

  const { error: insErr } = await supabase.from('invite_attributions').insert({
    invitee_account_id: p.inviteeAccountId,
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
    inviteeAccountId: p.inviteeAccountId,
    inviterAccountId: owned.account_id,
    eventType: INVITE_EVENT.ATTRIBUTED,
  });
  return { ok: true, attributed: true };
}

async function loadAttribution(supabase: InviteClient, inviteeAccountId: string) {
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

export async function maybeMarkOnboarded(supabase: InviteClient, accountId: string) {
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
    console.warn('[invite] onboard hook:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'error' };
  }
}

export async function maybeMarkFirstTx(
  supabase: InviteClient,
  p: {
    accountId?: string;
    kind?: string;
    amount?: string | number;
    ok?: boolean;
    counterpartyAccountId?: string | null;
    destinationIsOwnWallet?: boolean;
  }
) {
  try {
    if (!isQualifyingFirstTx(p) || !p.accountId) {
      return { ok: true, stamped: false, reason: 'not_qualifying' };
    }
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
    console.warn('[invite] first tx hook:', err instanceof Error ? err.message : err);
    return { ok: false, reason: 'error' };
  }
}

export async function tryCountInviteLocal(supabase: InviteClient, inviteeAccountId: string) {
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

export async function tryCountInvite(supabase: InviteClient, inviteeAccountId: string) {
  if (!inviteeAccountId) return { ok: false, reason: 'noop' };
  try {
    if (typeof supabase.rpc === 'function') {
      const { data, error } = await supabase.rpc('try_count_invite', {
        p_invitee: inviteeAccountId,
      });
      if (!error && data && typeof data === 'object') {
        return { ok: Boolean(data.ok), reason: data.reason || (data.ok ? undefined : 'noop') };
      }
      if (error && !isMissingRelation(error)) {
        console.warn('[invite] try_count_invite rpc:', error.message);
      }
    }
    return tryCountInviteLocal(supabase, inviteeAccountId);
  } catch (err) {
    console.warn('[invite] try_count_invite:', err instanceof Error ? err.message : err);
    try {
      return await tryCountInviteLocal(supabase, inviteeAccountId);
    } catch (inner) {
      console.warn(
        '[invite] try_count_invite local:',
        inner instanceof Error ? inner.message : inner
      );
      return { ok: false, reason: 'error' };
    }
  }
}

export async function inviteStatsFor(
  supabase: InviteClient,
  inviterAccountId: string
): Promise<{ attributed: number; counted: number }> {
  if (!inviterAccountId) return { attributed: 0, counted: 0 };
  const { data, error } = await supabase
    .from('invite_attributions')
    .select('invitee_account_id, counted_at')
    .eq('inviter_account_id', inviterAccountId);
  if (error) {
    if (isMissingRelation(error)) return { attributed: 0, counted: 0 };
    throw new Error(`invite count read failed: ${error.message}`);
  }
  const rows = (data || []) as Array<{ counted_at?: string | null }>;
  return {
    attributed: rows.length,
    counted: rows.filter((row) => row.counted_at).length,
  };
}

export async function countedInvitesFor(supabase: InviteClient, inviterAccountId: string) {
  const stats = await inviteStatsFor(supabase, inviterAccountId);
  return stats.counted;
}

export async function inviteCodeIfAttachEnabled(
  supabase: InviteClient,
  accountId: string
): Promise<string | null> {
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
    console.warn('[invite] attach lookup:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function getInviteSummary(
  supabase: InviteClient,
  accountId: string,
  siteUrl: string
): Promise<{
  code: string;
  url: string;
  attributed: number;
  counted: number;
  attachOnClaims: boolean;
} | null> {
  const issued = await ensureInviteCode(supabase, accountId);
  if (!issued.ok) return null;
  const stats = await inviteStatsFor(supabase, accountId);
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
    attributed: stats.attributed,
    counted: stats.counted,
    attachOnClaims,
  };
}

export { reservedKey };
