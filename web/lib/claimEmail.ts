import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendMail } from './sendMail.ts';
import { parseEmail } from './email.ts';
import { siteOrigin } from './siteOrigin.ts';
import { displaySafeLabel } from './sanitize.ts';
import { formatUsernameLabel } from './username.ts';
import { formatClaimAmount } from './claimAmount.ts';
import * as fees from './fees.ts';
import { recordClaimEvent } from '../../lib/claimEvents.js';

/**
 * Emailing a claim's recipient who is not on Flizy (migration
 * 20261117150000_claim_email_notices.sql). Called only through
 * /api/internal/claim-notice with a claim id: the address is read from the
 * claim here, never taken from the caller.
 *
 * One email right after the hold landed, and one reminder if it is still
 * unclaimed after CLAIM_EMAIL_REMINDER_HOURS (default 72). Never to an address
 * on a Flizy account (that recipient is told in chat), never to a suppressed
 * address, and within the limits: CLAIM_EMAIL_PER_SENDER_DAY new addresses a
 * sender may email a day (default 10), CLAIM_EMAIL_PER_ADDRESS_DAY emails an
 * address may get a day from everyone (default 3), and CLAIM_EMAIL_MIN_USD,
 * the smallest claim worth an email (off by default).
 *
 * The email only opens the claim page. It carries no code, no password field
 * and nothing that asks for credentials.
 */

export type ClaimEmailKind = 'first' | 'reminder';
export type ClaimEmailResult =
  | 'sent'
  | 'not_found'
  | 'not_pending'
  | 'not_email'
  | 'on_flizy'
  | 'suppressed'
  | 'too_early'
  | 'not_first'
  | 'limited'
  | 'below_minimum'
  | 'already'
  | 'failed';

const DAY_MS = 24 * 3600 * 1000;

type Env = Record<string, string | undefined>;

function whole(raw: string | undefined, fallback: number, name: string): number {
  const text = String(raw ?? '').trim();
  if (!text) return fallback;
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number`);
  return Number(text);
}

/** The limits, from the environment. A malformed one throws, so no email goes out on a wrong limit. */
export function claimEmailConfig(env: Env = process.env) {
  const min = String(env.CLAIM_EMAIL_MIN_USD ?? '').trim();
  return {
    perSenderDay: whole(env.CLAIM_EMAIL_PER_SENDER_DAY, 10, 'CLAIM_EMAIL_PER_SENDER_DAY'),
    perAddressDay: whole(env.CLAIM_EMAIL_PER_ADDRESS_DAY, 3, 'CLAIM_EMAIL_PER_ADDRESS_DAY'),
    reminderHours: whole(env.CLAIM_EMAIL_REMINDER_HOURS, 72, 'CLAIM_EMAIL_REMINDER_HOURS'),
    minMicro: min ? fees.parseUsdMicro(min, 'CLAIM_EMAIL_MIN_USD') : null,
  };
}

/** SHA-256 of the normalised address: how an address is counted and suppressed without being stored. */
export function emailHash(raw: unknown): string {
  return createHash('sha256').update(parseEmail(raw)).digest('hex');
}

/** The email itself. Plain words, ASCII, one link to the claim page, and the stop link. */
export function formatClaimEmail(p: {
  sender: string;
  amount: string;
  sentAt: string;
  expiresAt: string | null;
  claimUrl: string;
  stopUrl: string;
  reference: string;
  origin: string;
  reminder: boolean;
}): { subject: string; text: string; html: string } {
  const day = (iso: string) => new Date(iso).toUTCString().replace(/ GMT$/, ' UTC');
  const subject = `${p.reminder ? 'Reminder: ' : ''}${p.sender} sent you ${p.amount} on Flizy (testnet)`;
  const lines = [
    `${p.sender} sent you ${p.amount} on Flizy.`,
    '',
    `Sent: ${day(p.sentAt)}`,
    ...(p.expiresAt ? [`Can be claimed until: ${day(p.expiresAt)}`] : []),
    'These are test funds on a test network (testnet), not real money.',
    '',
    `Open the payment: ${p.claimUrl}`,
    `Payment reference: ${p.reference}`,
    '',
    `Flizy will never ask for your password or a code by email. Only open links that start with ${p.origin}.`,
    '',
    `Don't want emails like this? Stop these emails: ${p.stopUrl}`,
  ];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = [
    `<p>${esc(p.sender)} sent you <strong>${esc(p.amount)}</strong> on Flizy.</p>`,
    `<p>Sent: ${esc(day(p.sentAt))}${p.expiresAt ? `<br>Can be claimed until: ${esc(day(p.expiresAt))}` : ''}<br>These are test funds on a test network (testnet), not real money.</p>`,
    `<p><a href="${esc(p.claimUrl)}" style="display:inline-block;padding:10px 16px;background:#f7d047;color:#1a1405;text-decoration:none;border-radius:4px;font-weight:600">Open the payment</a></p>`,
    `<p>Payment reference: ${esc(p.reference)}</p>`,
    `<p style="color:#666">Flizy will never ask for your password or a code by email. Only open links that start with ${esc(p.origin)}.</p>`,
    `<p style="color:#666">Don't want emails like this? <a href="${esc(p.stopUrl)}">Stop these emails</a>.</p>`,
  ].join('\n');
  return { subject, text: lines.join('\n'), html };
}

/** Whether an address belongs to a Flizy account: its registration email, or a verified secondary one. */
async function onFlizy(db: SupabaseClient, email: string): Promise<boolean> {
  const like = email.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const { data: acct, error } = await db.from('accounts').select('id').ilike('email', like).limit(1);
  if (error) throw new Error(error.message);
  if ((acct || []).length) return true;
  const { data: extra, error: eErr } = await db.from('account_emails').select('id').ilike('email', like).not('verified_at', 'is', null).limit(1);
  if (eErr) throw new Error(eErr.message);
  return (extra || []).length > 0;
}

/** How many notices since `since`, not counting ones that failed. */
async function recentCount(db: SupabaseClient, column: 'sender_account_id' | 'recipient_hash', value: string, since: string, kind?: ClaimEmailKind) {
  let q = db.from('claim_email_notices').select('id', { count: 'exact', head: true }).eq(column, value).gte('created_at', since).in('state', ['sending', 'sent']);
  if (kind) q = q.eq('kind', kind);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

/** USD of a claim, for the minimum. Only ETH and tUSD are priced here; anything else does not clear a minimum. */
function claimUsdMicro(amount: unknown, asset: string): bigint | null {
  const cfg = fees.feeConfig();
  const text = String(amount ?? '');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [w, f = ''] = text.split('.');
  const micro = BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  if (asset === 'ETH') return (micro * cfg.ethUsd) / 1_000_000n;
  if (asset === 'TUSD') return micro;
  return null;
}

/**
 * Email a claim's recipient, once per kind, if every rule allows it. Never
 * throws for a rule: the claim is held either way. Logs never carry the address.
 */
export async function sendClaimEmail(p: {
  db: SupabaseClient;
  claimId: string;
  kind: ClaimEmailKind;
  env?: Env;
  now?: number;
  send?: typeof sendMail;
}): Promise<ClaimEmailResult> {
  const { db, claimId, kind } = p;
  const env = p.env || process.env;
  const now = p.now ?? Date.now();
  const cfg = claimEmailConfig(env);

  const { data: claim, error } = await db
    .from('claims')
    .select('id, status, to_email, from_account_id, amount_eth, asset, nft_token_id, claim_token, hold_tx_hash, expires_at, created_at')
    .eq('id', claimId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!claim) return 'not_found';
  // Claims are written once their hold landed; the hash says it did.
  if (claim.status !== 'pending' || !claim.hold_tx_hash) return 'not_pending';
  const email = parseEmail(claim.to_email);
  if (!email) return 'not_email';
  if (await onFlizy(db, email)) return 'on_flizy';

  const hash = emailHash(email);
  const { data: stopped, error: sErr } = await db.from('email_suppressions').select('email_hash').eq('email_hash', hash).maybeSingle();
  if (sErr) throw new Error(sErr.message);
  if (stopped) return 'suppressed';

  if (kind === 'reminder') {
    if (Date.parse(String(claim.created_at)) > now - cfg.reminderHours * 3600 * 1000) return 'too_early';
    const { data: first, error: fErr } = await db.from('claim_email_notices').select('state').eq('claim_id', claimId).eq('kind', 'first').maybeSingle();
    if (fErr) throw new Error(fErr.message);
    if (!first || first.state !== 'sent') return 'not_first';
  }

  const since = new Date(now - DAY_MS).toISOString();
  if (kind === 'first' && claim.from_account_id && (await recentCount(db, 'sender_account_id', String(claim.from_account_id), since, 'first')) >= cfg.perSenderDay) return 'limited';
  if ((await recentCount(db, 'recipient_hash', hash, since)) >= cfg.perAddressDay) return 'limited';

  const asset = String(claim.asset || 'ETH').toUpperCase();
  if (cfg.minMicro != null) {
    const usd = claim.nft_token_id ? null : claimUsdMicro(claim.amount_eth, asset);
    if (usd == null || usd < cfg.minMicro) return 'below_minimum';
  }

  // Taken first, so a retry or a second caller finds it and sends nothing.
  const { error: insErr } = await db
    .from('claim_email_notices')
    .insert({ claim_id: claimId, kind, sender_account_id: claim.from_account_id || null, recipient_hash: hash, state: 'sending' });
  if (insErr) {
    if (insErr.code === '23505') return 'already';
    throw new Error(insErr.message);
  }

  const { data: from } = await db.from('accounts').select('username, display_name').eq('id', claim.from_account_id).maybeSingle();
  const sender = formatUsernameLabel(from?.username) || (from?.display_name ? displaySafeLabel(String(from.display_name)) : '') || 'A Flizy user';
  const origin = siteOrigin();
  const mail = formatClaimEmail({
    sender,
    amount: formatClaimAmount({ amount_eth: claim.amount_eth, asset, nft_token_id: claim.nft_token_id }),
    sentAt: String(claim.created_at),
    expiresAt: claim.expires_at ? String(claim.expires_at) : null,
    claimUrl: `${origin}/claim/${claim.claim_token}`,
    stopUrl: `${origin}/email/stop?c=${claim.claim_token}`,
    reference: `FLZ-${String(claim.id).slice(0, 8).toUpperCase()}`,
    origin,
    reminder: kind === 'reminder',
  });

  const sent = await (p.send || sendMail)({ to: email, subject: mail.subject, text: mail.text, html: mail.html });
  const mark = (state: 'sent' | 'failed') =>
    db.from('claim_email_notices').update({ state, sent_at: state === 'sent' ? new Date(now).toISOString() : null }).eq('claim_id', claimId).eq('kind', kind);
  if (!sent.ok) {
    await mark('failed');
    console.warn(`[claim-email] ${kind} for claim ${claimId} not accepted by the mail provider`);
    return 'failed';
  }
  await mark('sent');
  await recordClaimEvent(db, claimId, 'notified', { channel: 'email', meta: kind === 'reminder' ? { kind: 'reminder' } : null });
  return 'sent';
}

/**
 * Stop claim emails to the address a claim was sent to, from the link in the
 * email (the claim token). Stores only the hash. The payment is untouched.
 */
export async function suppressClaimAddress(db: SupabaseClient, claimToken: string): Promise<'stopped' | 'not_found'> {
  if (!/^[0-9a-f]{32}$/.test(claimToken)) return 'not_found';
  const { data: claim, error } = await db.from('claims').select('to_email').eq('claim_token', claimToken).maybeSingle();
  if (error) throw new Error(error.message);
  const email = parseEmail(claim?.to_email);
  if (!email) return 'not_found';
  const { error: insErr } = await db.from('email_suppressions').upsert({ email_hash: emailHash(email) }, { onConflict: 'email_hash', ignoreDuplicates: true });
  if (insErr) throw new Error(insErr.message);
  return 'stopped';
}
