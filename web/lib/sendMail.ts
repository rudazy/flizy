/**
 * Outbound email: codes, account notices and payment emails.
 *
 * Two senders, both on flizy.app (the example values are in .env.example):
 *   default   EMAIL_FROM. Login and verification codes, security notices,
 *             API key notices, and anything that is not about money moving.
 *   payments  PAYMENTS_EMAIL_FROM, with Reply-To PAYMENTS_REPLY_TO
 *             (web/lib/publicMail.ts). Claim emails and reminders, payment
 *             received, large API payouts. Unset: EMAIL_FROM.
 * With no From set there is no guess: production logs an error and sends
 * nothing; development logs the body instead.
 *
 * Transport, in order:
 *   1) SMTP. Gmail when GMAIL_USER + GMAIL_APP_PASSWORD are set (an app
 *      password, not the account password; every From above must be a
 *      "Send mail as" address of GMAIL_USER), or SMTP_HOST / SMTP_USER /
 *      SMTP_PASS for another server.
 *   2) Resend, only when RESEND_API_KEY is set: when SMTP is not configured,
 *      or SMTP failed.
 *   3) Development only: log the body.
 *
 * All of these are server-side settings, never NEXT_PUBLIC_. Errors handed
 * back to callers name no setting; the detail goes to the server log.
 */

// Explicit extension: this module is also loaded straight by node --test.
import { PAYMENTS_REPLY_TO } from './publicMail.ts';

export type SendMailResult =
  | { ok: true; id?: string }
  | { ok: false; error: string; code?: string };

/** Which From an email goes out under. */
export type MailSender = 'default' | 'payments';

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  sender?: MailSender;
};

type Env = Record<string, string | undefined>;

/** A message with its envelope worked out, as a transport receives it. */
export type OutgoingMail = Omit<MailMessage, 'sender'> & { from: string; replyTo?: string };

/** Sends, or answers null when it is not configured. */
export type MailTransport = (mail: OutgoingMail, env: Env) => Promise<SendMailResult | null>;

const NOT_CONFIGURED: SendMailResult = {
  ok: false,
  error: 'Email sending is not configured.',
  code: 'MAIL_NOT_CONFIGURED',
};

const setting = (env: Env, name: string) => String(env[name] || '').trim();

/** From and Reply-To for a sender, or null when no From is set. */
export function senderFor(sender: MailSender = 'default', env: Env = process.env): { from: string; replyTo?: string } | null {
  const base = setting(env, 'EMAIL_FROM');
  if (sender === 'payments') {
    const from = setting(env, 'PAYMENTS_EMAIL_FROM') || base;
    return from ? { from, replyTo: PAYMENTS_REPLY_TO } : null;
  }
  return base ? { from: base } : null;
}

function isProd(env: Env): boolean {
  return env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production';
}

const sendViaSmtp: MailTransport = async (mail, env) => {
  const gmailUser = setting(env, 'GMAIL_USER');
  const gmailPass = setting(env, 'GMAIL_APP_PASSWORD').replace(/\s+/g, '');
  const smtpHost = setting(env, 'SMTP_HOST');
  const smtpUser = setting(env, 'SMTP_USER') || gmailUser;
  const smtpPass = (setting(env, 'SMTP_PASS') || gmailPass).replace(/\s+/g, '');
  const smtpPort = Number(env.SMTP_PORT || (gmailUser ? 465 : 587));

  const host = smtpHost || (gmailUser ? 'smtp.gmail.com' : '');
  if (!host || !smtpUser || !smtpPass) return null;

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: mail.from,
      replyTo: mail.replyTo,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });

    return { ok: true, id: info.messageId ? String(info.messageId) : 'smtp' };
  } catch (err) {
    console.warn('[sendMail] SMTP error:', err instanceof Error ? err.message : err);
    return { ok: false, error: 'Could not send the email. Try again shortly.', code: 'MAIL_SMTP' };
  }
};

const sendViaResend: MailTransport = async (mail, env) => {
  const key = setting(env, 'RESEND_API_KEY');
  if (!key) return null;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mail.from,
        to: [mail.to],
        reply_to: mail.replyTo || undefined,
        subject: mail.subject,
        text: mail.text,
        html: mail.html || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (body && (body.message || body.error)) || `Email provider error (${res.status})`;
      console.warn('[sendMail] Resend error:', msg);
      return { ok: false, error: 'Could not send the email. Try again shortly.', code: 'MAIL_PROVIDER' };
    }
    return { ok: true, id: body?.id ? String(body.id) : undefined };
  } catch (err) {
    console.warn('[sendMail] Resend network:', err instanceof Error ? err.message : err);
    return { ok: false, error: 'Could not send the email. Try again shortly.', code: 'MAIL_NETWORK' };
  }
};

export async function sendMail(
  p: MailMessage,
  deps: { env?: Env; transports?: MailTransport[] } = {}
): Promise<SendMailResult> {
  const env = deps.env || process.env;
  const transports = deps.transports || [sendViaSmtp, sendViaResend];

  const envelope = senderFor(p.sender, env);
  if (!envelope) {
    if (isProd(env)) {
      console.error('[sendMail] no From address set (EMAIL_FROM); email not sent');
      return NOT_CONFIGURED;
    }
    console.warn('[sendMail] No From address set. Email body:\n', p.text);
    return { ok: true, id: 'dev-log' };
  }

  const mail: OutgoingMail = { to: p.to, subject: p.subject, text: p.text, html: p.html, ...envelope };
  let failed: SendMailResult | null = null;
  for (const transport of transports) {
    const out = await transport(mail, env);
    if (!out) continue;
    if (out.ok) return out;
    failed = failed || out;
  }
  if (failed) return failed;

  if (!isProd(env)) {
    console.warn('[sendMail] No mail transport configured. Email body:\n', p.text);
    return { ok: true, id: 'dev-log' };
  }
  console.error('[sendMail] no mail transport configured; email not sent');
  return NOT_CONFIGURED;
}
