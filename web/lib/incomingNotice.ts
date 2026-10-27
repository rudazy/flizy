/**
 * A payment that reached an account: one row in account_notices, and one
 * email to the registration address.
 *
 * The text is built here. Callers pass the amount, the asset, and a label.
 * They do not pass the sentence or the link, so a caller cannot put a command
 * marker or a different website into the mail. A failure is logged and never
 * thrown: the payment has already landed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { takeBudget } from './followRate.ts';
import { formatPaymentReceived } from './payNotice.ts';
import { mailOwner } from './securityNotice.ts';
import { siteOrigin } from './siteOrigin.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX = /^0x[0-9a-f]{64}$/;
const ASSET = /^[A-Za-z][A-Za-z0-9]{0,11}$/;
const PART = /^[a-z0-9]{1,16}$/;
const HOUR_MS = 60 * 60 * 1000;
const HOUR_CAP = 30;
const KEEP = 40;

const reads = new Map<string, number[]>();
const marks = new Map<string, number[]>();

export type IncomingPayment = {
  accountId: string;
  txHash: string;
  amount: string;
  asset: string;
  fromLabel: string;
  note?: string | null;
  /** sale is a completed NFT sale. Anything else is a payment. */
  tag?: 'payment' | 'sale';
  /** Distinguishes two payments of the same asset in one transaction. */
  part?: string | null;
};

export type BuiltIncoming = {
  accountId: string;
  dedupeKey: string;
  body: string;
  subject: string;
  text: string;
};

export type NoticeView = {
  id: string;
  body: string;
  createdAt: string;
  unread: boolean;
};

export type NoticeSave = 'mailed' | 'already' | 'unmailed' | 'skipped' | 'unavailable' | 'capped';

/** 60 notice reads per account per minute. */
export function allowNoticeRead(accountId: string, now = Date.now()): boolean {
  return takeBudget(reads, accountId, 60, 60 * 1000, now);
}

/** 30 mark-read writes per account per minute. */
export function allowNoticeMark(accountId: string, now = Date.now()): boolean {
  return takeBudget(marks, accountId, 30, 60 * 1000, now);
}

function plainAmount(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!/^\d{1,12}(\.\d+)?$/.test(raw)) return null;
  const [whole, frac = ''] = raw.split('.');
  let text = frac ? `${whole}.${frac.slice(0, 18)}` : whole;
  text = text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (text === '0') return null;
  return /^\d{1,12}(\.\d{1,18})?$/.test(text) ? text : null;
}

function plainLabel(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[{}]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, max);
}

function walletUrlOk(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== '/dashboard/wallet') return false;
    const host = url.hostname.toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1';
    const ours = host === 'flizy.app' || host.endsWith('.flizy.app');
    if (!local && !ours) return false;
    if (url.protocol === 'https:') return true;
    return local && url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** The row and the email, or null when the input is not a real payment. */
export function buildIncomingPayment(input: IncomingPayment, walletUrl: string): BuiltIncoming | null {
  const accountId = String(input.accountId || '').trim();
  const txHash = String(input.txHash || '').trim().toLowerCase();
  const amount = plainAmount(input.amount);
  const asset = String(input.asset || '').trim();
  const tag = input.tag === 'sale' ? 'sale' : 'payment';
  const part = input.part == null || input.part === '' ? '' : String(input.part).trim().toLowerCase();
  if (!UUID.test(accountId) || !TX.test(txHash) || !amount || !ASSET.test(asset)) return null;
  if (part && !PART.test(part)) return null;
  if (!walletUrlOk(walletUrl)) return null;
  const fromLabel = plainLabel(input.fromLabel, 40) || 'someone';
  const note = plainLabel(input.note, 80);
  const body = formatPaymentReceived({
    amount,
    asset,
    fromLabel,
    note: note || null,
    walletUrl,
  });
  if (body.length > 600 || /\{\{cmd:/.test(body)) return null;
  const dedupeKey = `in:${txHash}:${tag}${part ? `-${part}` : ''}:${asset.toLowerCase()}`;
  if (dedupeKey.length > 96) return null;
  return {
    accountId,
    dedupeKey,
    body,
    subject: 'You received a payment on Flizy',
    text: [
      body,
      '',
      'This notice means money reached your Flizy wallet. It is not a request to pay anyone.',
    ].join('\n'),
  };
}

function unavailable(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || error.code === 'PGRST205' || /account_notices/i.test(error.message || '');
}

async function stampMailed(supabase: SupabaseClient, accountId: string, id: string): Promise<void> {
  const { error } = await supabase
    .from('account_notices')
    .update({ mailed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId);
  if (error) console.warn('[payment-notice] could not record that the email was sent');
}

/** A notice from the last hour that has not been emailed yet. */
async function unmailedRecent(supabase: SupabaseClient, accountId: string, dedupeKey: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('account_notices')
    .select('id, mailed_at, created_at')
    .eq('account_id', accountId)
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();
  if (error || !data?.id || data.mailed_at) return null;
  const age = Date.now() - Date.parse(String(data.created_at || ''));
  if (!Number.isFinite(age) || age > HOUR_MS) return null;
  return String(data.id);
}

async function deliver(supabase: SupabaseClient, built: BuiltIncoming, id: string): Promise<boolean> {
  const sent = await mailOwner(supabase, built.accountId, { subject: built.subject, text: built.text });
  if (!sent) return false;
  await stampMailed(supabase, built.accountId, id);
  return true;
}

async function trimOld(supabase: SupabaseClient, accountId: string): Promise<void> {
  const { data } = await supabase
    .from('account_notices')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .range(KEEP, KEEP + 40);
  const ids = (data || []).map((row) => String(row.id || '')).filter((id) => UUID.test(id));
  if (!ids.length) return;
  await supabase.from('account_notices').delete().eq('account_id', accountId).in('id', ids);
}

/**
 * Store the notice and email it once. Never throws.
 * `already` means this transaction was already recorded.
 */
export async function saveIncomingPayment(
  supabase: SupabaseClient,
  input: IncomingPayment
): Promise<NoticeSave> {
  try {
    const built = buildIncomingPayment(input, `${siteOrigin()}/dashboard/wallet`);
    if (!built) return 'skipped';

    const since = new Date(Date.now() - HOUR_MS).toISOString();
    const { count, error: countError } = await supabase
      .from('account_notices')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', built.accountId)
      .gte('created_at', since);
    if (countError) {
      if (unavailable(countError)) {
        console.warn('[payment-notice] payment notices are not available yet');
        return 'unavailable';
      }
      console.warn('[payment-notice] could not count notices');
      return 'skipped';
    }

    // A repeat of a notice that is already stored still gets one mail attempt
    // when the first send did not land. A new one stops at the hourly cap.
    if ((count ?? 0) >= HOUR_CAP) {
      const pending = await unmailedRecent(supabase, built.accountId, built.dedupeKey);
      if (!pending) {
        console.warn('[payment-notice] hourly cap reached');
        return 'capped';
      }
      return (await deliver(supabase, built, pending)) ? 'mailed' : 'unmailed';
    }

    const { data, error } = await supabase
      .from('account_notices')
      .upsert(
        {
          account_id: built.accountId,
          kind: 'payment',
          body: built.body,
          dedupe_key: built.dedupeKey,
        },
        { onConflict: 'account_id,dedupe_key', ignoreDuplicates: true }
      )
      .select('id')
      .maybeSingle();
    if (error) {
      if (unavailable(error)) {
        console.warn('[payment-notice] payment notices are not available yet');
        return 'unavailable';
      }
      console.warn('[payment-notice] could not store the notice');
      return 'skipped';
    }

    const createdId = data?.id ? String(data.id) : '';
    if (createdId) {
      const sent = await deliver(supabase, built, createdId);
      try {
        await trimOld(supabase, built.accountId);
      } catch {
        // The notice is already stored. A trim failure must not hide that.
      }
      return sent ? 'mailed' : 'unmailed';
    }

    const pending = await unmailedRecent(supabase, built.accountId, built.dedupeKey);
    if (!pending) return 'already';
    return (await deliver(supabase, built, pending)) ? 'mailed' : 'unmailed';
  } catch (err) {
    console.warn('[payment-notice] not sent');
    return 'skipped';
  }
}

export async function listPaymentNotices(supabase: SupabaseClient, accountId: string): Promise<NoticeView[]> {
  const { data, error } = await supabase
    .from('account_notices')
    .select('id, body, created_at, read_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) {
    if (unavailable(error)) throw new Error('Payment notices are not available yet.');
    throw new Error('could not list payment notices');
  }
  return (data || []).map((row) => ({
    id: String(row.id),
    body: String(row.body || '').slice(0, 600),
    createdAt: String(row.created_at || ''),
    unread: !row.read_at,
  }));
}

export async function markPaymentNotices(
  supabase: SupabaseClient,
  accountId: string,
  which: { all: true } | { id: string }
): Promise<void> {
  let query = supabase
    .from('account_notices')
    .update({ read_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .is('read_at', null);
  if ('id' in which) query = query.eq('id', which.id);
  const { error } = await query;
  if (error) {
    if (unavailable(error)) throw new Error('Payment notices are not available yet.');
    throw new Error('could not mark payment notices');
  }
}
