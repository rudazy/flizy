'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthStage } from '../../components/AuthStage';
import { useComingSoon } from '../../components/ComingSoon';
import { PasswordField } from '../../components/PasswordField';
import { LanguageSelect, useLocale } from '../../components/LocaleProvider';
import { track } from '../../lib/analytics';
import { clearAppearanceCache } from '../../lib/appearanceCache';
import { passwordChecklist, validatePassword } from '../../lib/passwordPolicy';
import type { LocaleCode } from '../../lib/locale';
import { safeNext } from '../../lib/safeNext.ts';
import { HONEYPOT_FIELD } from '../../lib/honeypot.ts';
import { SITE_PHONE_COUNTRIES } from '../../lib/phoneFormat';

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
  const [showSoon, soonNote] = useComingSoon();

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

  useEffect(() => {
    if (!needsCode) return;
    const wide = window.matchMedia('(min-width: 1024px)').matches;
    const target = document.getElementById(wide ? 'desk-code' : 'signup-code');
    target?.focus();
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [needsCode]);

  useEffect(() => {
    const footer = document.querySelector('footer');
    const previous = document.body.style.overflow;
    const desktop = window.matchMedia('(min-width: 1024px)');
    const apply = () => {
      if (!desktop.matches) {
        footer?.removeAttribute('inert');
        document.body.style.overflow = previous;
        return;
      }
      footer?.setAttribute('inert', '');
      document.body.style.overflow = 'hidden';
    };
    apply();
    desktop.addEventListener('change', apply);
    return () => {
      desktop.removeEventListener('change', apply);
      footer?.removeAttribute('inert');
      document.body.style.overflow = previous;
    };
  }, []);

  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const passwordRules = passwordChecklist(password);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
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
    <>
    {soonNote}
    <div className="fade-up mx-auto grid max-w-5xl gap-10 lg:hidden">
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
                {country.name} (+{country.dial})
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

    <div className="fixed inset-x-0 bottom-0 top-[69px] z-30 hidden overflow-y-auto bg-[#07060a] font-sans text-paper lg:block">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute left-[4%] top-[4%] h-[520px] w-[520px] rounded-full border border-sun/10" />
        <div className="absolute left-[10%] top-[12%] h-[300px] w-[300px] rounded-full border border-sun/20" />
        <div className="absolute -left-16 top-0 h-[420px] w-[420px] rounded-full bg-sun/[0.06] blur-3xl" />
      </div>
      <div className="relative mx-auto grid w-full max-w-[1120px] grid-cols-[minmax(0,1fr)_minmax(380px,440px)] items-start gap-12 px-8 py-8">
        <div className="max-w-[460px]">
          <p className="inline-flex items-center gap-2 rounded-[4px] border border-sun/40 bg-black/50 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-sun">
            <ShieldGlyph />
            Chat wallet
          </p>
          <h1 className="mt-5 font-sans text-[3rem] font-semibold leading-[0.98] tracking-tight text-paper xl:text-[3.4rem]">
            Create your
            <span className="block text-sun">Flizy account</span>
          </h1>
          <p className="mt-4 max-w-sm text-[15px] leading-6 text-[#c8c2b8]">
            Use crypto on Telegram and WhatsApp. Simple, social, and secure.
          </p>
          <ol className="mt-6 space-y-4">
            <Step
              n="1"
              title="Create with email"
              note="Set your email and password."
              icon={<MailGlyph />}
            />
            <Step
              n="2"
              title="Verify your email"
              note="We'll send a 6-digit code."
              icon={<ShieldGlyph />}
            />
            <Step
              n="3"
              title="Choose your username"
              note="Pick a unique @username and optional display name."
              icon={<PersonGlyph />}
            />
          </ol>
          <AuthStage variant="signup" />
          <div className="flex items-center gap-3 rounded-[6px] border border-[#8a7040]/50 bg-[#100e0b] px-4 py-3 shadow-[inset_0_1px_0_rgba(247,208,71,0.08)]">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-sun/40 text-sun">
              <LockGlyph />
            </span>
            <span>
              <span className="block font-sans text-[14px] text-paper">One account. Both chats.</span>
              <span className="mt-0.5 block text-[12px] leading-4 text-muted">
                Set an unlock PIN, then connect Telegram and WhatsApp from Account.
              </span>
            </span>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="relative overflow-hidden rounded-[8px] border border-[#8a7040]/80 bg-[linear-gradient(180deg,#16130e_0%,#0c0b09_42%)] px-6 py-6 shadow-[0_0_0_1px_rgba(247,208,71,0.08),0_30px_80px_rgba(0,0,0,0.5),0_0_64px_rgba(224,184,74,0.12)]"
        >
          <span className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-sun to-transparent" aria-hidden />
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sun">Get started</p>
          <h2 className="mt-2 font-sans text-[1.7rem] font-semibold tracking-tight text-paper">
            Create your Flizy account
          </h2>
          <p className="mt-2 text-sm leading-5 text-[#c8c2b8]">
            After signup you set an unlock PIN, then connect WhatsApp or Telegram from Account.
          </p>
          <div className="mt-5 space-y-3.5">
            <div>
              <label className={deskLabel} htmlFor="desk-locale">
                {t('auth.signup.language')}
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8f877c]">
                  <GlobeGlyph />
                </span>
                <LanguageSelect
                  id="desk-locale"
                  className={deskInput}
                  value={locale}
                  onChange={(code: LocaleCode) => setLocale(code)}
                />
              </div>
            </div>
            <div>
              <label className={deskLabel} htmlFor="desk-country">
                Country <span className="font-normal text-muted">(optional)</span>
              </label>
              <select
                  id="desk-country"
                  className="input min-h-[48px] rounded-[10px] border-[#2c2822] bg-[#0a0908]"
                  value={countryIso}
                  onChange={(event) => setCountryIso(event.target.value)}
                >
                  <option value="">Skip for now</option>
                  {SITE_PHONE_COUNTRIES.map((country) => (
                    <option key={country.iso} value={country.iso}>
                      {country.name} (+{country.dial})
                    </option>
                  ))}
              </select>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Pick one country and chat can finish a local number if needed. You can change this
                anytime.
              </p>
            </div>
            <div>
              <label className={deskLabel} htmlFor="desk-email">
                {t('auth.signup.email')}
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8f877c]">
                  <MailGlyph />
                </span>
                <input
                  id="desk-email"
                  className={deskInput}
                  type="email"
                  required
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  readOnly={needsCode}
                  autoComplete="email"
                />
              </div>
            </div>
            {/* Same trap as the phone form: off-screen, not a one-pixel box a bot can skip. */}
            <div className="absolute left-[-9999px] h-px w-px overflow-hidden" aria-hidden="true">
              <label htmlFor="desk-note">Note</label>
              <input
                id="desk-note"
                name={HONEYPOT_FIELD}
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
              />
            </div>
            <PasswordField
              id="desk-password"
              label={t('auth.signup.password')}
              labelClassName={deskLabel}
              inputClassName="min-h-[48px] rounded-[10px] border-[#2c2822] bg-[#0a0908]"
              value={password}
              onChange={setPassword}
              required
              minLength={8}
              placeholder="Create a strong password"
              autoComplete="new-password"
              leading={<LockGlyph />}
              iconToggle
            />
            <ul className="space-y-1">
              {passwordRules.map((rule) => (
                <li key={rule.label} className="flex items-center gap-2 text-[12px] text-muted">
                  <span
                    className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
                      rule.ok ? 'border-sun text-sun' : 'border-[#5c564c]'
                    }`}
                  >
                    {rule.ok ? <Tick /> : null}
                  </span>
                  {rule.label}
                </li>
              ))}
            </ul>
            <PasswordField
              id="desk-confirm"
              label={t('auth.signup.confirm')}
              labelClassName={deskLabel}
              inputClassName="min-h-[48px] rounded-[10px] border-[#2c2822] bg-[#0a0908]"
              value={confirmPassword}
              onChange={setConfirmPassword}
              required
              minLength={8}
              placeholder="Type it again"
              autoComplete="new-password"
              leading={<LockGlyph />}
              iconToggle
              problem={mismatch ? 'Passwords do not match yet.' : undefined}
              hint="Both entries must match exactly."
            />
            <div>
              <label className={deskLabel} htmlFor="desk-invite">
                Invite code <span className="font-normal text-muted">(optional)</span>
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8f877c]">
                  <GiftGlyph />
                </span>
                <input
                  id="desk-invite"
                  className={`${deskInput} font-mono`}
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
              <p className="mt-1.5 text-xs text-muted">Enter a referral code or username.</p>
            </div>
            {needsCode ? (
              <div>
                <div className="alert mb-3 text-sm" role="status">
                  Check {email} for a 6-digit code and enter it below to finish.
                </div>
                <label className={deskLabel} htmlFor="desk-code">
                  Email code
                </label>
                <input
                  id="desk-code"
                  className="input min-h-[48px] rounded-[10px] border-[#2c2822] bg-[#0a0908] font-mono"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="6-digit code"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                    if (error) setError('');
                  }}
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
              className="btn-sun flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] font-sans text-[15px]"
              type="submit"
              disabled={loading || mismatch || (needsCode && code.length !== 6)}
            >
              {loading ? t('auth.signup.submitting') : needsCode ? 'Finish' : 'Continue'}
              {loading || needsCode ? null : <ArrowGlyph />}
            </button>
            <p className="text-center text-xs text-muted">
              Next: we email a code, then you pick your @username.
            </p>
            <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-muted">
              <span className="h-px flex-1 bg-white/10" />
              or
              <span className="h-px flex-1 bg-white/10" />
            </div>
            <button
              type="button"
              onClick={() => showSoon('Continue with Google')}
              className="flex min-h-[52px] w-full items-center justify-center gap-3 rounded-[6px] border border-[#3a3228] bg-[#100e0b] px-4 text-[14px] text-paper shadow-[inset_0_1px_0_rgba(247,208,71,0.06)] hover:border-sun/50"
            >
              <GoogleG />
              <span>Continue with Google</span>
            </button>
            <button
              type="button"
              onClick={() => showSoon('Continue with a wallet')}
              className="flex min-h-[52px] w-full items-center gap-3 rounded-[6px] border border-[#3a3228] bg-[#100e0b] px-4 text-left shadow-[inset_0_1px_0_rgba(247,208,71,0.06)] hover:border-sun/50"
            >
              <WalletGlyph />
              <span className="min-w-0 flex-1">
                <span className="block font-sans text-[14px] text-paper">Continue with a wallet</span>
                <span className="mt-0.5 block text-[12px] text-muted">MetaMask, WalletConnect and more</span>
              </span>
            </button>
            <p className="text-center text-sm text-muted">
              {t('auth.signup.hasAccount')}{' '}
              <Link
                href={
                  next.startsWith('/claim/')
                    ? `/login?next=${encodeURIComponent(next)}`
                    : '/login'
                }
                className="text-sun no-underline hover:text-paper"
              >
                {t('auth.signup.login')}
              </Link>
            </p>
          </div>
        </form>
      </div>
    </div>
    </>
  );
}

const deskLabel = 'mb-1.5 block font-sans text-[13px] font-medium normal-case tracking-normal text-paper';
const deskInput = 'input min-h-[48px] rounded-[10px] border-[#2c2822] bg-[#0a0908] pl-11';

function Step({
  n,
  title,
  note,
  icon,
}: {
  n: string;
  title: string;
  note: string;
  icon: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-sun/50 font-mono text-[12px] text-sun">
        {n}
      </span>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-[#3a3228] text-sun">
        {icon}
      </span>
      <span>
        <span className="block font-sans text-[14px] text-paper">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-4 text-muted">{note}</span>
      </span>
    </li>
  );
}

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function PersonGlyph() {
  return (
    <Glyph>
      <circle cx="12" cy="9" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M7 17.2c.7-2.3 2.4-3.4 5-3.4s4.3 1.1 5 3.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

function MailGlyph() {
  return (
    <Glyph>
      <rect x="4" y="6" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="m5 8 7 5 7-5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </Glyph>
  );
}

function ShieldGlyph() {
  return (
    <Glyph>
      <path
        d="M12 4.5 18.5 7v4.6c0 3.4-2.3 5.8-6.5 7.4-4.2-1.6-6.5-4-6.5-7.4V7L12 4.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}

function LockGlyph() {
  return (
    <Glyph>
      <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10V8a4 4 0 0 1 8 0v2" stroke="currentColor" strokeWidth="1.6" />
    </Glyph>
  );
}

function GlobeGlyph() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M4 12h16M12 4c2.2 2.4 3.2 5 3.2 8s-1 5.6-3.2 8c-2.2-2.4-3.2-5-3.2-8s1-5.6 3.2-8Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </Glyph>
  );
}

function GiftGlyph() {
  return (
    <Glyph>
      <rect x="4" y="10" width="16" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 14h16M12 10v9M12 10c-2 0-4-1.2-4-3s2-2 4 3c2-5 4-3.2 4-3s-2 3-4 3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </Glyph>
  );
}

function ArrowGlyph() {
  return (
    <Glyph>
      <path d="M5 12h12M13 7l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Glyph>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" aria-hidden>
      <path d="m6 12 4 4 8-8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletGlyph() {
  return (
    <Glyph>
      <rect x="3.5" y="6.5" width="17" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
    </Glyph>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4 shrink-0" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.9z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.3 26.7 36 24 36c-5.3 0-9.8-3.4-11.4-8.1l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#c8c2b8"
        d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.3 4.1-4.2 5.4l6.3 5.3C40.3 35.8 44 31 44 24c0-1.3-.1-2.7-.4-3.9z"
      />
    </svg>
  );
}
