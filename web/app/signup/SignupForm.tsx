'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { PasswordField } from '../../components/PasswordField';
import { LanguageSelect, useLocale } from '../../components/LocaleProvider';
import { track } from '../../lib/analytics';
import { clearAppearanceCache } from '../../lib/appearanceCache';
import { validatePassword } from '../../lib/passwordPolicy';
import type { LocaleCode } from '../../lib/locale';
import { safeNext } from '../../lib/safeNext.ts';
import { HONEYPOT_FIELD } from '../../lib/honeypot.ts';
import { SITE_PHONE_COUNTRIES, countryFlag } from '../../lib/phoneFormat';

/**
 * Stage 1: email and password, then the 6-digit code from the inbox, which is
 * what signs the browser in (POST /api/auth/signup/verify). Signup answers the
 * same way for every address, so the code step is shown whatever the email.
 * Stage 3 (username) runs on the /dashboard gate.
 */
export function SignupForm() {
  const router = useRouter();
  const { t, locale, setLocale } = useLocale();
  const [next, setNext] = useState('/dashboard?welcome=1');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  // Honeypot. Stays empty for anyone using the form; see lib/honeypot.ts.
  const [honeypot, setHoneypot] = useState('');
  const [countryIso, setCountryIso] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setNext(safeNext(q.get('next'), '/dashboard?welcome=1'));
    const fromQuery = (q.get('invite') || q.get('i') || '').replace(/^@/, '');
    if (fromQuery) {
      setInviteCode(fromQuery);
      return;
    }
    let cancelled = false;
    fetch('/api/invite/pending', { cache: 'no-store' })
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled && body?.code) setInviteCode(String(body.code));
      })
      .catch(() => {
        /* field stays empty; cookie still attributes on submit */
      });
    return () => {
      cancelled = true;
    };
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
    // The dashboard can take seconds to open; the button stays busy until it
    // does, rather than flipping back to "Continue" as if signing up failed.
    let leaving = false;
    try {
      if (needsCode) {
        const res = await fetch('/api/auth/signup/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, code }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'That code did not work.');
        track('signup_completed', { locale });
        clearAppearanceCache();
        leaving = true;
        router.push('/dashboard');
        return;
      }
      await requestCode();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      if (!leaving) setLoading(false);
    }
  }

  /** Send (or send again) the signup request, which emails the code. */
  async function requestCode() {
    setNotice('');
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        locale,
        countryIso,
        inviteCode,
        [HONEYPOT_FIELD]: honeypot,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Signup failed');
    if (needsCode) setNotice('We sent a new code. Only the newest one works.');
    setNeedsCode(true);
    setCode('');
    setDevCode(typeof data.devCode === 'string' ? data.devCode : '');
  }

  async function resend() {
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      await requestCode();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a new code');
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
          <label className="label" htmlFor="signup-country">
            Country <span className="font-normal text-muted">(optional)</span>
          </label>
          <select
            id="signup-country"
            className="input min-h-[44px]"
            value={countryIso}
            onChange={(event) => setCountryIso(event.target.value)}
          >
            <option value="">Skip for now</option>
            {SITE_PHONE_COUNTRIES.map((country) => (
              <option key={country.iso} value={country.iso}>
                {countryFlag(country.iso)} {country.name} (+{country.dial})
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Pick one country and chat can finish a local number. Korea, then 10 1234 5678, is sent
            as +82 10 1234 5678. Skip this if you want. You can change it anytime.
          </p>
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
            readOnly={needsCode}
            autoComplete="email"
          />
        </div>
        {/*
          Honeypot. Positioned off-screen rather than display:none, because a
          bot that skips hidden inputs would also skip this one. aria-hidden and
          tabIndex keep it away from screen readers and the tab order, so nobody
          using the form can reach it by any route. See lib/honeypot.ts for why
          the field is named the way it is.
        */}
        <div className="absolute left-[-9999px] h-px w-px overflow-hidden" aria-hidden="true">
          <label htmlFor={HONEYPOT_FIELD}>Note</label>
          <input
            id={HONEYPOT_FIELD}
            name={HONEYPOT_FIELD}
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
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
        {needsCode ? (
          <div>
            <div className="alert mb-3 text-sm" role="status">
              Check {email} for a 6-digit code and enter it below to finish.
            </div>
            <label className="label" htmlFor="signup-code">
              Email code
            </label>
            <input
              id="signup-code"
              className="input font-mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => {
                setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                if (error) setError('');
              }}
              autoFocus
              required
            />
            {devCode ? (
              <p className="mt-1.5 font-mono text-xs text-lime">
                Local build, no mail configured. Your code is {devCode}
              </p>
            ) : null}
            <p className="mt-1.5 text-xs text-muted">
              It expires in 15 minutes. Nothing arrived?{' '}
              <button
                type="button"
                className="text-lime underline-offset-2 hover:text-gold"
                onClick={() => void resend()}
                disabled={loading}
              >
                Send a new code
              </button>
            </p>
          </div>
        ) : null}
        {notice ? (
          <div className="alert alert-ok text-sm" role="status">
            {notice}
          </div>
        ) : null}
        {error ? <div className="alert alert-error">{error}</div> : null}
        <button
          className="btn btn-primary w-full"
          type="submit"
          disabled={loading || mismatch || (needsCode && code.length !== 6)}
        >
          {loading ? t('auth.signup.submitting') : needsCode ? 'Finish' : 'Continue'}
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
