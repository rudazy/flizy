/**
 * Outbound email for verification codes.
 *
 * Priority:
 *   1) Gmail / generic SMTP — free path without a custom domain
 *      GMAIL_USER + GMAIL_APP_PASSWORD  (or SMTP_HOST / SMTP_USER / SMTP_PASS)
 *   2) Resend HTTP API — needs verified domain for production to arbitrary inboxes
 *      RESEND_API_KEY + optional EMAIL_FROM
 *   3) Dev log only (non-production)
 *
 * Gmail setup (recommended while you only have flizybuildbot@gmail.com):
 *   1. Google Account → Security → 2-Step Verification ON
 *   2. App passwords → create one for "Mail"
 *   3. Vercel env:
 *        GMAIL_USER=flizybuildbot@gmail.com
 *        GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
 *        EMAIL_FROM=Flizy <flizybuildbot@gmail.com>
 */

export type SendMailResult =
  | { ok: true; id?: string }
  | { ok: false; error: string; code?: string };

function fromAddress(): string {
  return (
    String(process.env.EMAIL_FROM || '').trim() ||
    (process.env.GMAIL_USER
      ? `Flizy <${String(process.env.GMAIL_USER).trim()}>`
      : 'Flizy <onboarding@resend.dev>')
  );
}

function isProd(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';
}

async function sendViaSmtp(p: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendMailResult | null> {
  const gmailUser = String(process.env.GMAIL_USER || '').trim();
  const gmailPass = String(process.env.GMAIL_APP_PASSWORD || '')
    .trim()
    .replace(/\s+/g, '');
  const smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpUser = String(process.env.SMTP_USER || gmailUser || '').trim();
  const smtpPass = String(process.env.SMTP_PASS || gmailPass || '')
    .trim()
    .replace(/\s+/g, '');
  const smtpPort = Number(process.env.SMTP_PORT || (gmailUser ? 465 : 587));

  const host = smtpHost || (gmailUser ? 'smtp.gmail.com' : '');
  if (!host || !smtpUser || !smtpPass) return null;

  try {
    // Dynamic import so local typecheck still works if types are present
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.createTransport({
      host,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const info = await transporter.sendMail({
      from: fromAddress(),
      to: p.to,
      subject: p.subject,
      text: p.text,
      html: p.html,
    });

    return { ok: true, id: info.messageId ? String(info.messageId) : 'smtp' };
  } catch (err) {
    console.warn('[sendMail] SMTP error:', err instanceof Error ? err.message : err);
    return {
      ok: false,
      error:
        'Could not send email via Gmail/SMTP. Check GMAIL_USER and GMAIL_APP_PASSWORD (App Password, not normal password).',
      code: 'MAIL_SMTP',
    };
  }
}

async function sendViaResend(p: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendMailResult | null> {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  if (!key) return null;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [p.to],
        subject: p.subject,
        text: p.text,
        html: p.html || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (body && (body.message || body.error)) || `Email provider error (${res.status})`;
      console.warn('[sendMail] Resend error:', msg);
      return {
        ok: false,
        error:
          'Could not send via Resend. Without a verified domain, use Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD) instead.',
        code: 'MAIL_PROVIDER',
      };
    }
    return { ok: true, id: body?.id ? String(body.id) : undefined };
  } catch (err) {
    console.warn('[sendMail] Resend network:', err instanceof Error ? err.message : err);
    return { ok: false, error: 'Could not send email. Try again shortly.', code: 'MAIL_NETWORK' };
  }
}

export async function sendMail(p: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<SendMailResult> {
  // Prefer Gmail/SMTP when configured — works without a paid domain.
  const smtp = await sendViaSmtp(p);
  if (smtp) return smtp;

  const resend = await sendViaResend(p);
  if (resend) return resend;

  if (!isProd()) {
    console.warn('[sendMail] No mail transport configured. Email body:\n', p.text);
    return { ok: true, id: 'dev-log' };
  }

  return {
    ok: false,
    error:
      'Email sending is not configured. Set GMAIL_USER + GMAIL_APP_PASSWORD (free) or RESEND_API_KEY + verified domain.',
    code: 'MAIL_NOT_CONFIGURED',
  };
}
