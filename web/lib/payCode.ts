/**
 * Short pay codes (web mirror of lib/payCode.js).
 * Vercel Root Directory is web, so ../lib is never uploaded.
 */

import { randomInt } from 'crypto';
import { normalizeUsername } from './username.ts';

export const PAY_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PAY_CODE_LENGTH = 6;
export const PAY_CODE_FORMAT = /^[2-9A-HJ-NP-Z]{6}$/;
export const PAY_CODE_ISSUE_TRIES = 8;

type PayClient = {
  from: (table: string) => any;
};

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === '42P01' || code === 'PGRST205' || /does not exist/i.test(message);
}

export function normalizePayCode(raw: unknown): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^2-9A-HJ-NP-Z]/g, '');
}

export function isPayCodeFormat(raw: unknown): boolean {
  return PAY_CODE_FORMAT.test(normalizePayCode(raw));
}

export function mintPayCode(): string {
  let out = '';
  for (let i = 0; i < PAY_CODE_LENGTH; i += 1) {
    out += PAY_CODE_ALPHABET[randomInt(PAY_CODE_ALPHABET.length)];
  }
  return out;
}

export async function ensurePayCode(
  supabase: PayClient,
  accountId: string
): Promise<{ ok: true; code: string; created: boolean } | { ok: false; reason: string }> {
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

export async function resolvePayCode(
  supabase: PayClient,
  raw: unknown
): Promise<{
  accountId: string;
  code: string;
  username: string | null;
  displayName: string | null;
} | null> {
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

export async function hasPaidMerchantBefore(
  supabase: PayClient,
  payerAccountId: string,
  toAddress: string
): Promise<boolean> {
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

export async function isSavedMerchant(
  supabase: PayClient,
  payerAccountId: string,
  toAddress: string
): Promise<boolean> {
  if (!payerAccountId || !toAddress) return false;
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('id')
    .eq('account_id', payerAccountId)
    .ilike('address', toAddress)
    .maybeSingle();
  if (error) {
    if (isMissingRelation(error)) return false;
    throw new Error(`pay trusted read failed: ${error.message}`);
  }
  return Boolean(data);
}

export async function resolvePayRef(
  supabase: PayClient,
  raw: unknown
): Promise<{
  accountId: string;
  code: string | null;
  username: string | null;
  displayName: string | null;
} | null> {
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

export async function getPaySummary(
  supabase: PayClient,
  accountId: string,
  siteUrl: string
): Promise<{
  code: string;
  url: string;
  username: string | null;
  displayName: string | null;
} | null> {
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
