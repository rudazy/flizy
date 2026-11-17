'use client';

import { useState } from 'react';

/**
 * On a claim sent to an email this account does not have yet: add that email
 * and verify it with the code it is sent, without leaving the claim page,
 * then claim. The same routes as Account (/api/account/emails and
 * /api/auth/email/verify), so an address on another account is refused there
 * with the same neutral answer.
 */
export function ClaimEmailVerify({ onVerified }: { onVerified: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function post(url: string, body: Record<string, string>) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { ok: res.ok, body: await res.json().catch(() => ({})) };
  }

  async function add() {
    setBusy(true);
    setMsg('');
    try {
      const out = await post('/api/account/emails', { email });
      // Already listed on this account: a code can still be sent and entered.
      if (out.ok || out.body.error === 'That email is already on your account.') {
        const sent = out.ok ? out : await post('/api/auth/email/send-code', { purpose: 'secondary', email });
        setStep('code');
        // Development only: the code comes back instead of being mailed.
        if (sent.body.devCode) setMsg(`Development code: ${sent.body.devCode}`);
        else setMsg(out.ok && out.body.codeError ? out.body.codeError : 'We sent a code to that address. Enter it below.');
      } else {
        setMsg(out.body.error || 'Could not add that email.');
      }
    } catch {
      setMsg('Could not add that email. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setMsg('');
    try {
      const out = await post('/api/auth/email/verify', { purpose: 'secondary', email, code });
      if (!out.ok) {
        setMsg(out.body.error || 'That code did not work.');
        return;
      }
      onVerified();
    } catch {
      setMsg('Could not verify. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      {step === 'email' ? (
        <>
          <label className="text-xs text-muted" htmlFor="claim-email">
            The email this payment was sent to
          </label>
          <input id="claim-email" type="email" className="input" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button type="button" className="btn btn-primary" disabled={busy || !email.includes('@')} onClick={() => void add()}>
            {busy ? 'Sending...' : 'Send me a code'}
          </button>
        </>
      ) : (
        <>
          <label className="text-xs text-muted" htmlFor="claim-code">
            Code sent to {email}
          </label>
          <input id="claim-code" inputMode="numeric" className="input" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button type="button" className="btn btn-primary" disabled={busy || code.trim().length < 4} onClick={() => void verify()}>
            {busy ? 'Verifying...' : 'Verify and continue'}
          </button>
        </>
      )}
      {msg ? <p className="m-0 text-xs text-muted">{msg}</p> : null}
    </div>
  );
}
