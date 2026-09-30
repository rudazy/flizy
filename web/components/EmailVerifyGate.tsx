'use client';

/**
 * Full-screen gate: no dashboard features until registration email is verified.
 */

import { useEffect, useRef, useState } from 'react';
import { useDashboard } from './DashboardProvider';

/**
 * True only in a development build. Next inlines NODE_ENV at build time, so the
 * branch below this guard is removed from the production bundle entirely rather
 * than merely not taken.
 */
const IS_DEV_BUILD = process.env.NODE_ENV !== 'production';

export function EmailVerifyGate() {
  const { data, load, setMsg } = useDashboard();
  const email = data?.account?.email || '';
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [localError, setLocalError] = useState('');
  const [localOk, setLocalOk] = useState('');

  async function sendCode() {
    setBusy('send');
    setLocalError('');
    setLocalOk('');
    try {
      const res = await fetch('/api/auth/email/send-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'primary' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not send code');
      setLocalOk(
        body.devCode
          ? `Code sent (dev): ${body.devCode}`
          : 'Code sent. Check your inbox — and Spam / Junk / Promotions if you do not see it.'
      );
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not send code');
    } finally {
      setBusy('');
    }
  }

  /*
   * On a development build, fetch the code straight away.
   *
   * Nothing on a local machine can send mail: with no SMTP or Resend key
   * configured, sendMail logs the body and reports success, and
   * issueEmailVerificationCode hands the code back as `devCode` instead. But
   * the screen says to wait for an email, so somebody signing up locally sits
   * watching an inbox that will never receive anything. The code was always one
   * button press away and nothing said so.
   *
   * Production is unaffected: the guard is a build-time constant, so this whole
   * branch is removed from that bundle rather than merely skipped, and no extra
   * email is ever sent on a real deploy.
   */
  const devCodeRequested = useRef(false);
  useEffect(() => {
    if (!IS_DEV_BUILD) return;
    // React runs effects twice in development. Without this the code is issued
    // twice and the first one is invalidated before it can be used.
    if (devCodeRequested.current) return;
    devCodeRequested.current = true;
    void sendCode();
    // Once on mount. sendCode is stable enough for this and re-running it on
    // every render would mint codes in a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy('verify');
    setLocalError('');
    setLocalOk('');
    try {
      const res = await fetch('/api/auth/email/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'primary', code }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not verify');
      setMsg('Email verified. Welcome to Flizy.');
      await load();
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not verify');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="fade-up mx-auto max-w-md space-y-6 py-10">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Required</p>
        <h1 className="mt-2 font-sans text-3xl tracking-wide text-paper">Verify your email</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Enter the 6-digit code we send to{' '}
          <span className="font-mono text-paper">{email || 'your email'}</span> before you can use
          Flizy. This proves you control the inbox so only you can receive payments sent to that
          address.
        </p>
        {IS_DEV_BUILD ? (
          <p className="mt-2 text-xs text-muted">
            Local build: no mail is configured, so the code appears below and in
            the server terminal instead of arriving by email.
          </p>
        ) : null}
      </div>

      <div className="rounded-md border border-border bg-ink/40 px-4 py-4 space-y-4">
        {/*
          Inside the card with the buttons, not above the heading. On a phone
          with the keyboard up, an alert at the top of the page is off-screen
          from the button that produced it, and pressing Continue reads as
          pressing something broken.
        */}
        {localError ? (
          <div className="alert alert-error text-sm" role="alert">
            {localError}
          </div>
        ) : null}
        {localOk ? (
          <div className="alert alert-ok text-sm" role="status">
            {localOk}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-ghost w-full py-3 text-sm font-semibold"
          disabled={busy === 'send'}
          onClick={() => void sendCode()}
        >
          {busy === 'send' ? 'Sending…' : 'Send verification code'}
        </button>

        <form onSubmit={(e) => void verify(e)} className="space-y-3">
          <div>
            <label className="label" htmlFor="gate-email-code">
              Code from email
            </label>
            <input
              id="gate-email-code"
              className="input w-full font-mono tracking-widest"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              aria-describedby="gate-code-hint"
              required
            />
            {/*
              The button below is disabled until the code is exactly six digits.
              Without this line that is a dead control with no explanation,
              which is the same complaint as a button that does nothing.
            */}
            <p id="gate-code-hint" className="mt-1.5 text-xs text-muted">
              {code.length === 0
                ? 'Six digits from the email.'
                : code.length < 6
                  ? `${6 - code.length} more digit${6 - code.length === 1 ? '' : 's'} to go.`
                  : 'Ready to verify.'}
            </p>
          </div>
          <button
            type="submit"
            className="btn btn-primary w-full py-3 font-semibold"
            disabled={busy === 'verify' || code.length !== 6}
          >
            {busy === 'verify' ? 'Checking…' : 'Verify and continue'}
          </button>
        </form>

        <p className="font-mono text-[11px] leading-relaxed text-muted">
          Did not get the code? Check <span className="text-paper">Spam</span>,{' '}
          <span className="text-paper">Junk</span>, and <span className="text-paper">Promotions</span>
          . Wait about a minute, then tap Send again.
        </p>
      </div>
    </div>
  );
}
