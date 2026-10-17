'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AuthStage } from '../../components/AuthStage';
import { useComingSoon } from '../../components/ComingSoon';
import { LanguageSelect, useLocale } from '../../components/LocaleProvider';
import { PasswordField } from '../../components/PasswordField';
import { track } from '../../lib/analytics';
import { clearAppearanceCache } from '../../lib/appearanceCache';
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
  /** Said after a resend, because the new code silently replaces the old one. */
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [accountNote, setAccountNote] = useState('');
  const [showSoon, soonNote] = useComingSoon();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(safeNext(params.get('next')));
    const account = params.get('account');
    if (account === 'deleted' || account === 'deactivated') {
      setAccountNote('This account is paused. Enter the same email and the account password to bring it back.');
    }
  }, []);

  const paneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const footer = document.querySelector('footer');
    const header = document.querySelector('header');
    const previous = document.body.style.overflow;
    footer?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';
    const place = () => {
      const pane = paneRef.current;
      if (!pane) return;
      const height = header?.getBoundingClientRect().height ?? 69;
      pane.style.top = `${Math.round(height)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      footer?.removeAttribute('inert');
      document.body.style.overflow = previous;
    };
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
  useEffect(() => {
    if (!needsCode) return;
    const target = document.getElementById('desk-login-code');
    target?.focus();
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [needsCode]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');
    setNotice('');
    // Once the page is on its way to the dashboard the button stays busy, so it
    // never flips back to "Log in" and looks like the attempt failed.
    let leaving = false;
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
      clearAppearanceCache();
      leaving = true;
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      if (!leaving) setLoading(false);
    }
  }

  async function resendCode() {
    if (loading) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send code');
      setCode('');
      setDevCode(typeof data.devCode === 'string' ? data.devCode : '');
      setNotice(`New code sent to ${email}. Earlier codes no longer work.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send code');
    } finally {
      setLoading(false);
    }
  }

  const signupHref = next !== '/dashboard' ? `/signup?next=${encodeURIComponent(next)}` : '/signup';

  return (
    <>
    {soonNote}
    <div ref={paneRef} className="fixed inset-x-0 bottom-0 top-[109px] z-30 overflow-y-auto bg-[#07060a] font-sans text-paper lg:top-[71px]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        <div className="absolute left-[6%] top-[6%] h-[520px] w-[520px] rounded-full border border-sun/10" />
        <div className="absolute left-[12%] top-[14%] h-[320px] w-[320px] rounded-full border border-sun/20" />
        <div className="absolute -left-16 top-8 h-[420px] w-[420px] rounded-full bg-sun/[0.06] blur-3xl" />
      </div>
      <div className="relative mx-auto grid w-full max-w-[1120px] grid-cols-1 items-start gap-8 px-4 py-6 pb-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)] lg:gap-12 lg:px-8 lg:py-8">
        <div className="max-w-[460px]">
          <p className="inline-flex items-center gap-2 rounded-[4px] border border-sun/40 bg-black/50 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-sun">
            <ShieldMark />
            Chat wallet
          </p>
          <h1 className="mt-5 font-sans text-[2.15rem] font-semibold leading-[0.98] tracking-tight text-paper sm:text-[3rem] xl:text-[3.4rem]">
            Your wallet
            <span className="block text-sun">in your chats.</span>
          </h1>
          <p className="mt-4 max-w-sm text-[15px] leading-6 text-[#c8c2b8]">
            Use crypto on Telegram and WhatsApp. Simple, social, and secure.
          </p>
          <ul className="mt-6 space-y-3 lg:space-y-4">
            <Feature icon={<BoltMark />} title="Send to friends" note="With a simple username" />
            <Feature icon={<ChatMark />} title="Use where you are" note="Telegram and WhatsApp" />
            <Feature icon={<LockMark />} title="Unlock with a PIN" note="Set it on the dashboard" />
          </ul>
          <AuthStage variant="login" />
        </div>

        <form
          onSubmit={onSubmit}
          className="relative overflow-hidden rounded-[8px] border border-[#8a7040]/80 bg-[linear-gradient(180deg,#16130e_0%,#0c0b09_42%)] px-4 py-5 shadow-[0_0_0_1px_rgba(247,208,71,0.08),0_30px_80px_rgba(0,0,0,0.5),0_0_64px_rgba(224,184,74,0.12)] sm:px-6 sm:py-6"
        >
          <span className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-sun to-transparent" aria-hidden />
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sun">Welcome back</p>
          <h2 className="mt-2 font-sans text-[1.85rem] font-semibold tracking-tight text-paper">
            Log in to Flizy
          </h2>
          <p className="mt-2 text-sm leading-5 text-[#c8c2b8]">{t('auth.login.blurb')}</p>
          {accountNote ? (
            <div className="alert mt-4 text-sm" role="status">
              {accountNote}
            </div>
          ) : null}
          <div className="mt-5 space-y-3.5">
            <div>
              <label className={fieldLabel} htmlFor="desk-locale">
                {t('auth.signup.language')}
              </label>
              <LanguageSelect
                id="desk-locale"
                className={fieldInput}
                value={locale}
                onChange={(code: LocaleCode) => setLocale(code)}
              />
            </div>
            <div>
              <label className={fieldLabel} htmlFor="desk-email">
                {t('auth.login.email')}
              </label>
              <input
                id="desk-email"
                className={fieldInput}
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </div>
            <PasswordField
              id="desk-password"
              label={t('auth.login.password')}
              labelClassName={fieldLabel}
              inputClassName="min-h-[48px] rounded-[10px] border-[#2c2822] bg-[#0a0908]"
              value={password}
              onChange={setPassword}
              required
              placeholder="Enter your password"
              autoComplete="current-password"
              iconToggle
            />
            {needsCode ? (
              <div>
                <div className="alert mb-3 text-sm" role="status">
                  One more step. Enter the code below to finish signing in.
                </div>
                <label className={fieldLabel} htmlFor="desk-login-code">
                  Login code
                </label>
                <input
                  id="desk-login-code"
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
                  We emailed a code because this browser is new to this account, you signed out here,
                  or it has been 30 days. It expires in 15 minutes. Only the newest code works.
                </p>
                <button
                  type="button"
                  className="mt-2 text-sm text-sun underline-offset-2 hover:text-paper"
                  disabled={loading}
                  onClick={() => void resendCode()}
                >
                  Send a new code
                </button>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => showSoon('Remember me')}
                className="flex min-h-11 items-center gap-2 text-left text-[13px] text-paper"
              >
                <span className="h-4 w-4 shrink-0 rounded-[3px] border border-sun" />
                Remember me
              </button>
              <button
                type="button"
                onClick={() => showSoon('Forgot password')}
                className="min-h-11 text-[13px] font-medium text-sun hover:text-paper"
              >
                Forgot password?
              </button>
            </div>
            {notice ? (
              <div className="alert alert-ok text-sm" role="status">
                {notice}
              </div>
            ) : null}
            {error ? <div className="alert alert-error">{error}</div> : null}
            <button
              className="btn-sun flex min-h-12 w-full items-center justify-center gap-2 rounded-[10px] font-sans text-[15px]"
              type="submit"
              disabled={loading || (needsCode && code.length !== 6)}
            >
              {loading ? t('auth.login.submitting') : needsCode ? 'Verify and sign in' : 'Sign in'}
              {loading || needsCode ? null : <ArrowMark />}
            </button>
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-white/10" />
              or continue with
              <span className="h-px flex-1 bg-white/10" />
            </div>
            <SoonRow
              icon={<GoogleMark />}
              title="Continue with Google"
              onClick={() => showSoon('Continue with Google')}
            />
            <SoonRow
              icon={<WalletMark />}
              title="Continue with a wallet"
              note="MetaMask, WalletConnect and more"
              onClick={() => showSoon('Continue with a wallet')}
            />
            <SoonRow
              icon={<PasskeyMark />}
              title="Continue with a passkey"
              note="On this device"
              onClick={() => showSoon('Continue with a passkey')}
            />
            <p className="pt-1 text-center text-sm text-muted">
              {t('auth.login.newHere')}{' '}
              <Link href={signupHref} className="font-medium text-sun no-underline hover:text-paper">
                {t('auth.login.create')}
              </Link>
            </p>
          </div>
        </form>
      </div>
    </div>
    </>
  );
}

const fieldLabel = 'mb-1.5 block font-sans text-[13px] font-medium normal-case tracking-normal text-paper';
const fieldInput = 'input min-h-[48px] rounded-[10px] border-[#2c2822] bg-[#0a0908]';

function Feature({ icon, title, note }: { icon: ReactNode; title: string; note: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[4px] border border-sun/40 bg-[#100e0b] text-sun shadow-[inset_0_0_12px_rgba(247,208,71,0.08)]">
        {icon}
      </span>
      <span>
        <span className="block font-sans text-[14px] text-paper">{title}</span>
        <span className="mt-0.5 block text-[12px] text-muted">{note}</span>
      </span>
    </li>
  );
}

function SoonRow({
  icon,
  title,
  note,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  note?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[52px] w-full items-center gap-3 rounded-[6px] border border-[#3a3228] bg-[#100e0b] px-4 text-left shadow-[inset_0_1px_0_rgba(247,208,71,0.06)] hover:border-sun/50"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-sun/25 text-sun">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[14px] text-paper">{title}</span>
        {note ? <span className="mt-0.5 block text-[12px] text-muted">{note}</span> : null}
      </span>
      <ArrowMark />
    </button>
  );
}

function Mark({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

function ShieldMark() {
  return (
    <Mark>
      <path d="M12 3.5 19 6.2v5.2c0 4-2.7 6.7-7 8.6-4.3-1.9-7-4.6-7-8.6V6.2L12 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="m8.5 12 2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Mark>
  );
}

function BoltMark() {
  return (
    <Mark>
      <path d="M13 3 6 13h5l-1 8 8-12h-5l0-6Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </Mark>
  );
}

function ChatMark() {
  return (
    <Mark>
      <path d="M6 16.5 4.5 20 8.4 18A8 8 0 1 0 6 16.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </Mark>
  );
}

function LockMark() {
  return (
    <Mark>
      <rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10V8a4 4 0 0 1 8 0v2" stroke="currentColor" strokeWidth="1.6" />
    </Mark>
  );
}

function WalletMark() {
  return (
    <Mark>
      <rect x="3.5" y="6.5" width="17" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16" cy="14" r="1" fill="currentColor" />
    </Mark>
  );
}

function PasskeyMark() {
  return (
    <Mark>
      <circle cx="8" cy="14" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 14h9.5M16.5 14v2.4M19.2 14v2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </Mark>
  );
}

function ArrowMark() {
  return (
    <Mark>
      <path d="M5 12h12M13 7l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Mark>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4 shrink-0" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.9z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 35.3 26.7 36 24 36c-5.3 0-9.8-3.4-11.4-8.1l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#c8c2b8" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.3 4.1-4.2 5.4l6.3 5.3C40.3 35.8 44 31 44 24c0-1.3-.1-2.7-.4-3.9z" />
    </svg>
  );
}
