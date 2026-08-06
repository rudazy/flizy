/**
 * Email ownership codes for primary registration email and secondary addresses.
 * Codes are hashed; plaintext only lives in the outbound message (or dev logs).
 */

import crypto from 'crypto';
import { getSupabase } from './supabase.ts';
import { normalizeEmail, parseEmail, isValidEmail } from './email.ts';
import { sendMail } from './sendMail.ts';

export type EmailVerifyPurpose = 'primary' | 'secondary';

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const MIN_RESEND_MS = 45 * 1000;
const MAX_OPEN_PER_HOUR = 8;

function pepper(): string {
  return (
    process.env.EMAIL_CODE_SECRET ||
    process.env.OAUTH_STATE_SECRET ||
    process.env.WALLET_DERIVATION_SECRET ||
    'flizy-email-code-dev'
  );
}

export function hashEmailCode(code: string): string {
  return crypto.createHash('sha256').update(`${pepper()}:${String(code).trim()}`).digest('hex');
}

export function generateEmailCode(): string {
  // 6 digits, uniform enough for short TTL + attempt limit
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

function isMissingTable(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  return (
    err.code === '42P01' ||
    String(err.message || '').includes('email_verifications') ||
    String(err.message || '').includes('email_verified_at')
  );
}

/**
 * Issue a code, email it, invalidate older open codes for same account+purpose+email.
 */
export async function issueEmailVerificationCode(p: {
  accountId: string;
  email: string;
  purpose: EmailVerifyPurpose;
}): Promise<
  | { ok: true; email: string; expiresAt: string; devCode?: string }
  | { ok: false; error: string; status: number; code?: string }
> {
  const email = parseEmail(p.email);
  if (!email || !isValidEmail(email)) {
    return { ok: false, error: 'Invalid email address.', status: 400 };
  }
  if (!p.accountId) {
    return { ok: false, error: 'Not logged in.', status: 401 };
  }

  const supabase = getSupabase();

  // Rate limit: recent open rows for this account
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data: recent, error: rErr } = await supabase
    .from('email_verifications')
    .select('id, created_at')
    .eq('account_id', p.accountId)
    .gte('created_at', hourAgo)
    .order('created_at', { ascending: false })
    .limit(MAX_OPEN_PER_HOUR + 2);

  if (rErr && !isMissingTable(rErr)) {
    return { ok: false, error: 'Could not start verification.', status: 500 };
  }
  if (rErr && isMissingTable(rErr)) {
    return {
      ok: false,
      error: 'Email verification is not available yet (migration pending).',
      status: 503,
      code: 'MIGRATION_PENDING',
    };
  }

  if ((recent || []).length >= MAX_OPEN_PER_HOUR) {
    return {
      ok: false,
      error: 'Too many verification emails. Try again in about an hour.',
      status: 429,
      code: 'RATE_LIMIT',
    };
  }

  const latest = recent?.[0];
  if (latest?.created_at) {
    const age = Date.now() - new Date(latest.created_at).getTime();
    if (age < MIN_RESEND_MS) {
      const wait = Math.ceil((MIN_RESEND_MS - age) / 1000);
      return {
        ok: false,
        error: `Wait about ${wait}s before requesting another code.`,
        status: 429,
        code: 'RESEND_WAIT',
      };
    }
  }

  // Invalidate prior open codes for this email+purpose
  await supabase
    .from('email_verifications')
    .update({ consumed_at: new Date().toISOString() })
    .eq('account_id', p.accountId)
    .eq('purpose', p.purpose)
    .ilike('email', email)
    .is('consumed_at', null);

  const code = generateEmailCode();
  const code_hash = hashEmailCode(code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  const { error: insErr } = await supabase.from('email_verifications').insert({
    account_id: p.accountId,
    email,
    purpose: p.purpose,
    code_hash,
    expires_at: expiresAt,
  });
  if (insErr) {
    return { ok: false, error: 'Could not start verification.', status: 500 };
  }

  const subject = 'Your Flizy verification code';
  const text = [
    'Flizy email verification',
    '',
    `Your code: ${code}`,
    '',
    'It expires in 15 minutes.',
    'If you did not request this, ignore this email.',
  ].join('\n');

  const mailed = await sendMail({ to: email, subject, text });
  if (!mailed.ok) {
    return {
      ok: false,
      error: mailed.error,
      status: mailed.code === 'MAIL_NOT_CONFIGURED' ? 503 : 502,
      code: mailed.code,
    };
  }

  const out: { ok: true; email: string; expiresAt: string; devCode?: string } = {
    ok: true,
    email,
    expiresAt,
  };
  // Never expose codes in production responses
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env.VERCEL_ENV !== 'production' &&
    mailed.id === 'dev-log'
  ) {
    out.devCode = code;
  }
  return out;
}

/**
 * Consume a valid code and mark the email verified on the account or secondary row.
 */
export async function consumeEmailVerificationCode(p: {
  accountId: string;
  email: string;
  purpose: EmailVerifyPurpose;
  code: string;
}): Promise<{ ok: true } | { ok: false; error: string; status: number; code?: string }> {
  const email = parseEmail(p.email);
  const code = String(p.code || '').trim().replace(/\s+/g, '');
  if (!email || !isValidEmail(email)) {
    return { ok: false, error: 'Invalid email address.', status: 400 };
  }
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: 'Enter the 6-digit code from your email.', status: 400 };
  }
  if (!p.accountId) {
    return { ok: false, error: 'Not logged in.', status: 401 };
  }

  const supabase = getSupabase();
  const { data: rows, error } = await supabase
    .from('email_verifications')
    .select('id, code_hash, expires_at, attempts, consumed_at')
    .eq('account_id', p.accountId)
    .eq('purpose', p.purpose)
    .ilike('email', email)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    if (isMissingTable(error)) {
      return {
        ok: false,
        error: 'Email verification is not available yet (migration pending).',
        status: 503,
      };
    }
    return { ok: false, error: 'Could not verify code.', status: 500 };
  }

  const row = rows?.[0];
  if (!row) {
    return { ok: false, error: 'No active code. Request a new verification email.', status: 400 };
  }
  if (row.consumed_at) {
    return { ok: false, error: 'That code was already used. Request a new one.', status: 400 };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'That code expired. Request a new one.', status: 400 };
  }
  if (Number(row.attempts || 0) >= MAX_ATTEMPTS) {
    return {
      ok: false,
      error: 'Too many wrong codes. Request a new verification email.',
      status: 429,
    };
  }

  const expected = String(row.code_hash || '');
  const actual = hashEmailCode(code);
  const ok =
    expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));

  if (!ok) {
    await supabase
      .from('email_verifications')
      .update({ attempts: Number(row.attempts || 0) + 1 })
      .eq('id', row.id);
    return { ok: false, error: 'Incorrect code.', status: 400 };
  }

  const now = new Date().toISOString();
  await supabase
    .from('email_verifications')
    .update({ consumed_at: now })
    .eq('id', row.id);

  if (p.purpose === 'primary') {
    const { data: acc, error: aErr } = await supabase
      .from('accounts')
      .select('email')
      .eq('id', p.accountId)
      .maybeSingle();
    if (aErr || parseEmail(acc?.email) !== email) {
      return {
        ok: false,
        error: 'That code is not for your registration email.',
        status: 400,
      };
    }
    const { error: uErr } = await supabase
      .from('accounts')
      .update({ email_verified_at: now })
      .eq('id', p.accountId);
    if (uErr) {
      return { ok: false, error: 'Could not mark email verified.', status: 500 };
    }
  } else {
    const { data: sec, error: sErr } = await supabase
      .from('account_emails')
      .update({ verified_at: now })
      .eq('account_id', p.accountId)
      .ilike('email', email)
      .select('id')
      .maybeSingle();
    if (sErr || !sec) {
      return {
        ok: false,
        error: 'Add that email on Account first, then enter the code.',
        status: 400,
      };
    }
  }

  return { ok: true };
}

export function normalizePurpose(raw: unknown): EmailVerifyPurpose | null {
  const p = String(raw || '')
    .trim()
    .toLowerCase();
  if (p === 'primary' || p === 'register' || p === 'registration') return 'primary';
  if (p === 'secondary' || p === 'additional') return 'secondary';
  return null;
}

export { normalizeEmail };
