'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LanguageSelect, useLocale } from '../../components/LocaleProvider';
import { track } from '../../lib/analytics';
import type { LocaleCode } from '../../lib/locale';
import { safeNext } from '../../lib/safeNext.ts';

export function LoginForm() {
  const router = useRouter();
  const { t, locale, setLocale } = useLocale();
  const [next, setNext] = useState('/dashboard');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [devCode, setDevCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [accountNote, setAccountNote] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(safeNext(params.get('next')));
    const account = params.get('account');
    if (account === 'deleted') {
      setAccountNote('This sign-in was deleted and cannot be restored.');
    } else if (account === 'deactivated') {
      setAccountNote('This account is paused. Enter the account password to bring it back.');
    }
  }, []);

  /**
   * Put the cursor in the code box the moment it appears.
   *
   * Logging in can be two steps. The second inserts a field between the
   * password and the button, relabels the button and disables it until six
   * digits are typed. Somebody who does not notice the new field presses the
   * button again, nothing happens, and login looks broken.
   *
   * Moving the cursor there says what changed without a word of copy.
   */
  const codeRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!needsCode) return;
    codeRef.current?.focus();
    codeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [needsCode]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          ...(needsCode && code ? { code } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      if (data.needsCode) {
        setNeedsCode(true);
        setCode('');
        // Only ever present on a development build: with no mail transport the
        // server returns the code instead of sending it. Without it the code
        // box would have nothing that could fill it.
        setDevCode(typeof data.devCode === 'string' ? data.devCode : '');
        return;
      }
      track('login_completed');
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fade-up mx-auto max-w-md">
      <p className="text-xs uppercase tracking-[0.18em] text-gold">{t('auth.login.kicker')}</p>
      <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper">{t('auth.login.title')}</h1>
      <p className="mt-2 text-sm text-muted">{t('auth.login.blurb')}</p>
      {accountNote ? (
        <div className="alert mt-4 text-sm" role="status">
          {accountNote}
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="card mt-8 space-y-5 p-6 md:p-8">
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
            {t('auth.login.email')}
          </label>
          <input
            id="email"
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
        <div>
          <label className="label" htmlFor="password">
            {t('auth.login.password')}
          </label>
          <input
            id="password"
            className="input"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {needsCode ? (
          <div>
            {/*
              Stated as a step, in the same place errors appear, so the change of
              state is visible rather than implied by a relabelled button.
            */}
            <div className="alert mb-3 text-sm" role="status">
              One more step. Enter the code below to finish signing in.
            </div>
            <label className="label" htmlFor="login-code">
              Login code
            </label>
            <input
              ref={codeRef}
              id="login-code"
              className="input font-mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
            />
            {devCode ? (
              <p className="mt-1.5 font-mono text-xs text-lime">
                Local build, no mail configured. Your code is {devCode}
              </p>
            ) : null}
            <p className="mt-1.5 text-xs text-muted">
              We emailed a code because this is a new browser or it has been a while. It expires
              in 15 minutes.
            </p>
          </div>
        ) : null}
        {error ? <div className="alert alert-error">{error}</div> : null}
        <button
          className="btn btn-primary w-full"
          type="submit"
          disabled={loading || (needsCode && code.length !== 6)}
        >
          {loading
            ? t('auth.login.submitting')
            : needsCode
              ? 'Verify and sign in'
              : t('auth.login.submit')}
        </button>
        {needsCode ? (
          <button
            type="button"
            className="btn btn-ghost w-full text-sm"
            disabled={loading}
            onClick={async () => {
              setLoading(true);
              setError('');
              try {
                const res = await fetch('/api/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email, password }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Could not send code');
                setCode('');
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not send code');
              } finally {
                setLoading(false);
              }
            }}
          >
            Send a new code
          </button>
        ) : null}
        <p className="text-center text-sm text-muted">
          {t('auth.login.newHere')}{' '}
          <Link
            href={next !== '/dashboard' ? `/signup?next=${encodeURIComponent(next)}` : '/signup'}
            className="text-lime no-underline hover:text-gold"
          >
            {t('auth.login.create')}
          </Link>
        </p>
      </form>
    </div>
  );
}
