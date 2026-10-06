/**
 * Short pay codes (web mirror of lib/payCode.js).
 * Vercel Root Directory is web, so ../lib is never uploaded.
 */

import { randomInt } from 'crypto';
import { normalizeUsername } from './username.ts';
import { closureOf, isMissingClosureColumn } from './accountClosure.ts';

export const PAY_CODE_ALPHABET = '0123456789';
export const PAY_CODE_LENGTH = 9;
export const PAY_CODE_FORMAT = /^[0-9]{9}$/;
export const PAY_CODE_ISSUE_TRIES = 8;

type PayClient = {
  from: (table: string) => any;
};

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return code === '42P01' || code === 'PGRST205' || /does not exist/i.test(message);
}

/**
 * Anything a human might type or paste, reduced to the stored form. Strips the
 * grouping this is displayed with ("012 345 678") and any stray punctuation,
 * so a code read off a counter still matches.
 */
export function normalizePayCode(raw: unknown): string {
  return String(raw || '')
    .trim()
    .replace(/[^0-9]/g, '');
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

async function readPayableAccount(
  supabase: PayClient,
  column: string,
  value: string,
  columns: string,
  failLabel: string
): Promise<{
  closed: boolean;
  row: { id?: string; username?: string | null; display_name?: string | null } | null;
}> {
  const wider = `${columns}, deleted_at, deactivated_at`;
  let result = await supabase.from('accounts').select(wider).eq(column, value).maybeSingle();
  if (result.error && isMissingClosureColumn(result.error)) {
    result = await supabase.from('accounts').select(columns).eq(column, value).maybeSingle();
  }
  if (result.error && !isMissingRelation(result.error)) {
    throw new Error(`${failLabel}: ${result.error.message}`);
  }
  if (closureOf(result.data) === 'deleted') return { closed: true, row: null };
  return { closed: false, row: result.data || null };
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
  const acc = await readPayableAccount(
    supabase,
    'id',
    data.account_id,
    'username, display_name',
    'pay code account read failed'
  );
  if (acc.closed) return null;
  return {
    accountId: data.account_id,
    code: data.code,
    username: acc.row?.username || null,
    displayName: acc.row?.display_name || null,
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
  // Mirror of lib/payCode.js: status only, since a held destination is on the
  // list, and limit(1) because two casings of one address are two rows.
  const { data, error } = await supabase
    .from('trusted_addresses')
    .select('id')
    .eq('account_id', payerAccountId)
    .ilike('address', toAddress)
    .eq('status', 'active')
    .limit(1)
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
    const acc = await readPayableAccount(
      supabase,
      'username',
      asUser,
      'id, username, display_name',
      'pay username lookup failed'
    );
    if (acc.closed) return null;
    if (acc.row?.id) {
      const { data: pay } = await supabase
        .from('pay_codes')
        .select('code')
        .eq('account_id', acc.row.id)
        .maybeSingle();
      return {
        accountId: acc.row.id,
        code: pay?.code || null,
        username: acc.row.username || asUser,
        displayName: acc.row.display_name || null,
      };
    }
  }
  return resolvePayCode(supabase, raw);
}

/**
 * The two URLs a pay identity needs. Deliberate mirror of buildPayUrls in
 * lib/payCode.js -- see that header for why the printed QR must route on the
 * pay code and not the username. test/payUrls.test.js pins both sides.
 */
export function buildPayUrls(
  siteUrl: string,
  code: string,
  username: string | null
): { shareUrl: string; qrUrl: string } {
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
  // code exists -- nothing has been printed from it.
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

export async function getPaySummary(
  supabase: PayClient,
  accountId: string,
  siteUrl: string
): Promise<{
  code: string;
  url: string;
  qrUrl: string;
  username: string | null;
  displayName: string | null;
} | null> {
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
