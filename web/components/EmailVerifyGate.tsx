'use client';

/**
 * Full-screen gate: no dashboard features until registration email is verified.
 */

import { useState } from 'react';
import { useDashboard } from './DashboardProvider';

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
      </div>

      {localError ? <div className="alert alert-error text-sm">{localError}</div> : null}
      {localOk ? <div className="alert alert-ok text-sm">{localOk}</div> : null}

      <div className="rounded-md border border-border bg-ink/40 px-4 py-4 space-y-4">
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
              required
            />
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
