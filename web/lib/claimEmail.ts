import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendMail } from './sendMail.ts';
import { parseEmail } from './email.ts';
import { siteOrigin } from './siteOrigin.ts';
import { displaySafeLabel } from './sanitize.ts';
import { formatUsernameLabel } from './username.ts';
import { formatClaimAmount, isNftClaim } from './claimAmount.ts';
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
 * and nothing that asks for credentials. Its link carries the address after
 * the # (never sent to a server), so signing up from the claim page starts
 * with it filled in.
 *
 * Every decision about a claim's email is written down: sent or failed, or
 * skipped when a rule held it back. A skipped one is final, and counts toward
 * no limit.
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

/**
 * Gold coin art beside the amount, by asset (web/public/mail). ETH, USDT, USDC,
 * tUSD and FLZ get their own mark; any other token gets a plain coin, and an
 * NFT gets none, since a coin would misdescribe it.
 */
const COIN_ART: Record<string, string> = {
  ETH: 'coin-eth.png',
  USDT: 'coin-usdt.png',
  USDC: 'coin-usdc.png',
  TUSD: 'coin-tusd.png',
  FLZ: 'coin-flz.png',
};

export function claimCoinArt(asset: string | null | undefined, nft: boolean): string | null {
  if (nft) return null;
  return COIN_ART[String(asset || 'ETH').trim().toUpperCase()] || 'coin-coin.png';
}

/**
 * The email itself: a dark header, the amount with the asset's coin, the three
 * steps to receive it and one button to the claim page, then when it was sent,
 * when it expires, its reference, that it is test money, the warning about
 * links, the footer and the stop link. Built from tables and inline styles, so
 * it holds together in Gmail and Outlook, plus one media query in the head that
 * narrows it on phones (a client that drops it still gets the full layout).
 * ASCII only.
 */
export function formatClaimEmail(p: {
  sender: string;
  amount: string;
  /** The claim's asset symbol, for the coin art. Absent means ETH. */
  asset?: string | null;
  nft?: boolean;
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
  const heading = p.reminder ? 'Your payment is still waiting for you' : 'You received a payment on Flizy';
  const steps = [
    'Create a Flizy account using this email address, or sign in to your existing account.',
    'If you already have a Flizy account with another email, add and verify this email in your account.',
    'Return to this payment and claim your funds.',
  ];
  const details = [
    `Sent: ${day(p.sentAt)}`,
    ...(p.expiresAt ? [`Can be claimed until: ${day(p.expiresAt)}`] : []),
    `Payment reference: ${p.reference}`,
  ];
  const testnet = 'These are test funds on a test network (testnet), not real money.';
  const warning = `Flizy will never ask for your password or a code by email. Only open links that start with ${p.origin}.`;

  const lines = [
    heading,
    `${p.sender} sent you a payment through Flizy.`,
    '',
    'YOU HAVE RECEIVED',
    p.amount,
    'Waiting for you to claim',
    '',
    'How to receive your money',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `Claim your payment: ${p.claimUrl}`,
    '',
    ...details,
    testnet,
    '',
    warning,
    '',
    `Don't want emails like this? Stop these emails: ${p.stopUrl}`,
  ];

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const font = "font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";
  const T = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
  const img = (file: string) => `${esc(p.origin)}/mail/${file}`;
  const coin = claimCoinArt(p.asset, p.nft === true);
  // "Wed, 18 Nov 2026 20:16:22 UTC" split into the date and the time, one per line.
  const stamp = (iso: string) => {
    const [d, t] = day(iso).split(/ (?=\d\d:\d\d:\d\d)/);
    return `${esc(d)}<br>${esc(t || '')}`;
  };
  const tile = (size: number, text: number) =>
    `<td width="${size}" height="${size}" align="center" valign="middle" bgcolor="#0d0d0d" style="width:${size}px;height:${size}px;background:#0d0d0d;border:1px solid #6b5822;border-radius:${Math.round(size / 4.5)}px;color:#f7d047;font-size:${text}px;font-weight:800;line-height:1">F.</td>`;
  const meta = [
    ['Sent', stamp(p.sentAt)],
    ...(p.expiresAt ? [['Expires', stamp(p.expiresAt)]] : []),
    ['Payment reference', esc(p.reference)],
  ];
  const stepRows = steps
    .map((s, i) => {
      const line = i < steps.length - 1 ? '<tr><td align="center" style="padding:0"><div style="width:2px;height:16px;background:#f3dc8f;line-height:16px;font-size:0">&nbsp;</div></td><td></td></tr>' : '';
      return [
        '<tr>',
        `<td width="44" align="center" valign="top" style="width:44px;padding:0"><div style="width:32px;height:32px;border-radius:16px;background:#fbefc6;color:#1a1405;font-size:15px;font-weight:700;line-height:32px;text-align:center">${i + 1}</div></td>`,
        `<td valign="middle" style="padding:5px 0 0 12px;font-size:15px;line-height:1.45;color:#27272a">${esc(s)}</td>`,
        '</tr>',
        line,
      ].join('');
    })
    .join('');

  const html = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">',
    '<style>',
    '@media (max-width:520px){',
    '.fz-pad{padding-left:20px!important;padding-right:20px!important}',
    '.fz-h1{font-size:26px!important}',
    '.fz-amt{font-size:30px!important}',
    '.fz-coin{width:96px!important;height:auto!important}',
    '.fz-coincell{width:96px!important}',
    '.fz-col{display:block!important;width:100%!important;border-left:0!important;padding:10px 0!important}',
    '.fz-col+.fz-col{border-top:1px solid #e4e4e7!important}',
    '.fz-foot{display:block!important;width:100%!important;text-align:left!important;padding-top:12px!important}',
    '}',
    '</style></head>',
    `<body style="margin:0;padding:0;background:#f4f4f5;${font}">`,
    `<table ${T} width="100%" bgcolor="#f4f4f5" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 10px">`,
    `<table ${T} width="100%" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden;color:#18181b">`,
    // Header: dark, the logo tile, the gold arc behind "Payment Notification".
    `<tr><td bgcolor="#0d0d0d" background="${img('header-arc.png')}" style="background:#0d0d0d url('${img('header-arc.png')}') right top / auto 100% no-repeat;padding:22px 28px 38px" class="fz-pad">`,
    `<table ${T} width="100%"><tr>`,
    `<td width="40" style="width:40px"><table ${T}><tr>${tile(38, 18)}</tr></table></td>`,
    '<td style="padding-left:12px;color:#ffffff;font-size:24px;font-weight:700">Flizy</td>',
    '<td align="right" style="color:#d4d4d8;font-size:13px">Payment Notification</td>',
    '</tr></table>',
    '</td></tr>',
    // White body, rounded at the top so it sits over the header like a sheet.
    `<tr><td bgcolor="#0d0d0d" style="background:#0d0d0d;padding:0"><table ${T} width="100%"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:18px 18px 0 0;height:18px;line-height:18px;font-size:0">&nbsp;</td></tr></table></td></tr>`,
    '<tr><td class="fz-pad" style="padding:6px 28px 8px">',
    `<h1 class="fz-h1" style="margin:0;font-size:32px;line-height:1.15;font-weight:800;color:#0a0a0a">${esc(heading)}</h1>`,
    `<p style="margin:10px 0 22px;font-size:16px;line-height:1.5;color:#52525b">${esc(p.sender)} sent you a payment through Flizy.</p>`,
    // Amount box.
    `<table ${T} width="100%" bgcolor="#fdf3d6" style="background:#fdf3d6;background-image:linear-gradient(110deg,#fffaf0 0%,#fdf0cc 100%);border:1px solid #f3e2ab;border-radius:16px"><tr>`,
    '<td valign="middle" style="padding:22px 8px 22px 22px">',
    '<p style="margin:0;font-size:15px;color:#52525b">You have received</p>',
    `<p class="fz-amt" style="margin:4px 0 12px;font-size:38px;line-height:1.1;font-weight:800;color:#0a0a0a;word-break:break-word">${esc(p.amount)}</p>`,
    '<span style="display:inline-block;padding:7px 14px;border-radius:999px;background:#f8e4a4;color:#1a1405;font-size:14px;font-weight:600">Waiting for you to claim</span>',
    '</td>',
    coin
      ? `<td class="fz-coincell" width="150" align="right" valign="middle" style="width:150px;padding:10px 12px 10px 0"><img class="fz-coin" src="${img(coin)}" width="150" height="130" alt="" style="display:block;width:150px;height:130px;border:0"></td>`
      : '',
    '</tr></table>',
    // Steps.
    '<h2 style="margin:28px 0 16px;font-size:22px;line-height:1.25;font-weight:800;color:#0a0a0a">How to receive your money</h2>',
    `<table ${T} width="100%">${stepRows}</table>`,
    // The one button.
    `<table ${T} width="100%" style="margin-top:24px"><tr><td align="center" bgcolor="#f7d047" style="background:#f7d047;background-image:linear-gradient(180deg,#fadc63 0%,#f2c230 100%);border:1px solid #e3b62a;border-radius:10px">`,
    `<a href="${esc(p.claimUrl)}" style="display:block;padding:15px 16px;color:#1a1405;font-size:18px;font-weight:700;text-decoration:none">Claim your payment</a>`,
    '</td></tr></table>',
    // Sent, expires, reference.
    `<table ${T} width="100%" bgcolor="#f4f4f5" style="margin-top:22px;background:#f4f4f5;border-radius:12px"><tr><td style="padding:14px 18px">`,
    `<table ${T} width="100%"><tr>`,
    meta
      .map(
        ([label, value], i) =>
          `<td class="fz-col" valign="top" style="padding:2px ${i === meta.length - 1 ? 0 : 14}px 2px ${i === 0 ? 0 : 16}px;${i === 0 ? '' : 'border-left:1px solid #d4d4d8;'}"><p style="margin:0;font-size:13px;color:#71717a">${label}</p><p style="margin:4px 0 0;font-size:15px;line-height:1.4;font-weight:700;color:#18181b">${value}</p></td>`
      )
      .join(''),
    '</tr></table>',
    '</td></tr></table>',
    // Testnet.
    `<table ${T} width="100%" bgcolor="#fdf6e3" style="margin-top:12px;background:#fdf6e3;border-radius:10px"><tr>`,
    '<td width="22" valign="middle" style="width:22px;padding:11px 0 11px 16px"><div style="width:16px;height:16px;border:1.5px solid #52525b;border-radius:9px;color:#52525b;font-size:11px;font-weight:700;line-height:16px;text-align:center">i</div></td>',
    `<td valign="middle" style="padding:11px 16px 11px 12px;font-size:14px;line-height:1.45;color:#3f3f46">${esc(testnet)}</td>`,
    '</tr></table>',
    // Stay secure.
    `<table ${T} width="100%" style="margin-top:20px"><tr>`,
    `<td width="64" align="center" valign="middle" style="width:64px;border-right:1px solid #d4d4d8"><img src="${img('shield.png')}" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border:0"></td>`,
    '<td valign="middle" style="padding:2px 0 2px 24px">',
    '<p style="margin:0;font-size:18px;font-weight:700;color:#0a0a0a">Stay secure</p>',
    `<p style="margin:4px 0 0;font-size:14px;line-height:1.5;color:#52525b">Flizy will never ask for your password or a code by email. Only open links that start with <a href="${esc(p.origin)}" style="color:#a87b12;font-weight:600;text-decoration:underline">${esc(p.origin)}</a>.</p>`,
    '</td>',
    '</tr></table>',
    '</td></tr>',
    // Footer.
    '<tr><td class="fz-pad" style="padding:0 28px 26px">',
    `<table ${T} width="100%" style="margin-top:18px;border-top:1px solid #e4e4e7"><tr>`,
    '<td class="fz-foot" valign="top" style="padding-top:20px">',
    `<table ${T}><tr>${tile(32, 15)}<td style="padding-left:12px;font-size:20px;font-weight:700;color:#0a0a0a">Flizy</td></tr></table>`,
    '<p style="margin:10px 0 0;font-size:13px;line-height:1.55;color:#52525b">Chat wallet for WhatsApp and Telegram.<br>Trusted sends. Built for GIWA and EVM.</p>',
    '</td>',
    '<td class="fz-foot" align="right" valign="bottom" style="padding-top:20px;white-space:nowrap">',
    `<a href="${esc(p.origin)}" style="color:#18181b;font-size:14px;text-decoration:underline">Open Flizy</a>`,
    '<span style="display:inline-block;width:1px;height:14px;background:#d4d4d8;margin:0 14px;vertical-align:middle"></span>',
    `<a href="${esc(p.origin)}/how-it-works" style="color:#18181b;font-size:14px;text-decoration:underline">Help Center</a>`,
    '</td>',
    '</tr></table>',
    `<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:#71717a">Don't want emails like this? <a href="${esc(p.stopUrl)}" style="color:#71717a;text-decoration:underline">Stop these emails</a>.</p>`,
    '</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
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

/** How many notices since `since`, not counting ones that failed or were skipped. */
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
  const hash = emailHash(email);
  const skip = async (result: ClaimEmailResult): Promise<ClaimEmailResult> => {
    const { error: skipErr } = await db
      .from('claim_email_notices')
      .insert({ claim_id: claimId, kind, sender_account_id: claim.from_account_id || null, recipient_hash: hash, state: 'skipped' });
    if (skipErr && skipErr.code !== '23505') throw new Error(skipErr.message);
    return result;
  };
  if (await onFlizy(db, email)) return skip('on_flizy');

  const { data: stopped, error: sErr } = await db.from('email_suppressions').select('email_hash').eq('email_hash', hash).maybeSingle();
  if (sErr) throw new Error(sErr.message);
  if (stopped) return skip('suppressed');

  if (kind === 'reminder') {
    if (Date.parse(String(claim.created_at)) > now - cfg.reminderHours * 3600 * 1000) return 'too_early';
    const { data: first, error: fErr } = await db.from('claim_email_notices').select('state').eq('claim_id', claimId).eq('kind', 'first').maybeSingle();
    if (fErr) throw new Error(fErr.message);
    if (!first || first.state !== 'sent') return 'not_first';
  }

  const since = new Date(now - DAY_MS).toISOString();
  if (kind === 'first' && claim.from_account_id && (await recentCount(db, 'sender_account_id', String(claim.from_account_id), since, 'first')) >= cfg.perSenderDay) return skip('limited');
  if ((await recentCount(db, 'recipient_hash', hash, since)) >= cfg.perAddressDay) return skip('limited');

  const asset = String(claim.asset || 'ETH').toUpperCase();
  if (cfg.minMicro != null) {
    const usd = claim.nft_token_id ? null : claimUsdMicro(claim.amount_eth, asset);
    if (usd == null || usd < cfg.minMicro) return skip('below_minimum');
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
    asset,
    nft: isNftClaim({ nft_token_id: claim.nft_token_id }),
    sentAt: String(claim.created_at),
    expiresAt: claim.expires_at ? String(claim.expires_at) : null,
    claimUrl: `${origin}/claim/${claim.claim_token}#to=${encodeURIComponent(email)}`,
    stopUrl: `${origin}/email/stop?c=${claim.claim_token}`,
    reference: `FLZ-${String(claim.id).slice(0, 8).toUpperCase()}`,
    origin,
    reminder: kind === 'reminder',
  });

  const sent = await (p.send || sendMail)({ to: email, subject: mail.subject, text: mail.text, html: mail.html, sender: 'payments' });
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
