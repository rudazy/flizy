'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PasswordField } from '../../components/PasswordField';
import { LanguageSelect, useLocale } from '../../components/LocaleProvider';
import { track } from '../../lib/analytics';
import { validatePassword } from '../../lib/passwordPolicy';
import type { LocaleCode } from '../../lib/locale';

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard?welcome=1';
  return raw;
}

/**
 * Stage 1 only: email + password.
 * Stage 2 (verify email) and stage 3 (username) run on /dashboard gates.
 */
export function SignupForm() {
  const router = useRouter();
  const { t, locale, setLocale } = useLocale();
  const [next, setNext] = useState('/dashboard?welcome=1');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setNext(safeNext(q.get('next')));
    const fromQuery = q.get('invite') || q.get('i') || '';
    if (fromQuery) setInviteCode(fromQuery);
  }, []);

  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const policy = validatePassword(password);
    if (!policy.ok) {
      setError(policy.error);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          locale,
          inviteCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      track('signup_completed', { locale });
      // Always land on dashboard: email gate then profile gate.
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fade-up mx-auto grid max-w-5xl gap-10 lg:grid-cols-2 lg:items-start">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">{t('auth.signup.kicker')}</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper md:text-4xl">
          {t('auth.signup.title')}
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-muted">{t('auth.signup.blurb')}</p>
        <ol className="mt-8 space-y-3 text-sm text-muted">
          <li className="flex gap-3">
            <span className="text-lime">1</span> Create with email and password
          </li>
          <li className="flex gap-3">
            <span className="text-lime">2</span> Verify your email with a 6-digit code
          </li>
          <li className="flex gap-3">
            <span className="text-lime">3</span> Choose your @username and optional display name
          </li>
        </ol>
      </div>

      <form onSubmit={onSubmit} className="card space-y-5 p-6 md:p-8">
        <div>
          <label className="label" htmlFor="locale">
            {t('auth.signup.language')}
          </label>
          <LanguageSelect
            id="locale"
            value={locale}
            onChange={(code: LocaleCode) => setLocale(code)}
          />
        </div>
        <div>
          <label className="label" htmlFor="email">
            {t('auth.signup.email')}
          </label>
          <input
            id="email"
            className="input"
            type="email"
            required
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        <PasswordField
          id="password"
          label={t('auth.signup.password')}
          value={password}
          onChange={setPassword}
          required
          minLength={8}
          placeholder="e.g. MyPass1!"
          autoComplete="new-password"
          hint="At least 8 characters, with a letter, a number, and a special character (!@#$%…)."
        />
        <PasswordField
          id="confirm-password"
          label={t('auth.signup.confirm')}
          value={confirmPassword}
          onChange={setConfirmPassword}
          required
          minLength={8}
          placeholder="Type it again"
          autoComplete="new-password"
          problem={mismatch ? 'Passwords do not match yet.' : undefined}
          hint="Both entries must match exactly."
        />
        <div>
          <label className="label" htmlFor="invite-code">
            Invite <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="invite-code"
            className="input font-mono"
            type="text"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="@username"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            autoComplete="off"
          />
        </div>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <button className="btn btn-primary w-full" type="submit" disabled={loading || mismatch}>
          {loading ? t('auth.signup.submitting') : 'Continue'}
        </button>
        <p className="text-center text-xs text-muted">
          Next: we email a code, then you pick your @username.
        </p>
        <p className="text-center text-sm text-muted">
          {t('auth.signup.hasAccount')}{' '}
          <Link
            href={
              next.startsWith('/claim/')
                ? `/login?next=${encodeURIComponent(next)}`
                : '/login'
            }
            className="text-lime no-underline hover:text-gold"
          >
            {t('auth.signup.login')}
          </Link>
        </p>
      </form>
    </div>
  );
}
