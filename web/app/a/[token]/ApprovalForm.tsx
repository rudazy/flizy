'use client';

import { useEffect, useState } from 'react';

/**
 * Enter the PIN for one chat request: an unlock, a payment that needs it, or
 * an unlink. The request is shown from the server copy the bot wrote, never
 * from the URL. On success the person goes back to the chat, where the bot
 * carries on within a couple of seconds.
 */

type Loaded =
  | { status: 'loading' }
  | { status: 'open'; kind: string; title: string; lines: string[]; chatLabel: string; expiresAt: string }
  | { status: 'expired' | 'used' | 'replaced' | 'missing' | 'locked' | 'error'; message?: string }
  | { status: 'approved'; chatLabel: string };

const CLOSED_COPY: Record<string, string> = {
  expired: 'This link expired. Nothing happened. Go back to the chat and start again.',
  used: 'This link was already used.',
  replaced: 'This request was replaced or cancelled. Nothing happened.',
  missing: 'This link is not valid. Go back to the chat and start again.',
  error: 'Something went wrong. Try again in a moment.',
};

export function ApprovalForm({ token }: { token: string }) {
  const [state, setState] = useState<Loaded>({ status: 'loading' });
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/approvals/${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((body) => {
        if (cancelled) return;
        if (body?.status === 'open') {
          setState({
            status: 'open',
            kind: String(body.kind || ''),
            title: String(body.title || ''),
            lines: Array.isArray(body.lines) ? body.lines.map(String) : [],
            chatLabel: String(body.chatLabel || ''),
            expiresAt: String(body.expiresAt || ''),
          });
        } else {
          setState({ status: body?.status in CLOSED_COPY ? body.status : 'missing' });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || state.status !== 'open') return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json().catch(() => ({}));
      setPin('');
      if (body?.status === 'approved') {
        setState({ status: 'approved', chatLabel: String(body.chatLabel || state.chatLabel) });
        return;
      }
      if (body?.status === 'locked') {
        setState({ status: 'locked', message: String(body.error || '') });
        return;
      }
      if (body?.status && body.status !== 'open') {
        setState({ status: body.status in CLOSED_COPY ? body.status : 'missing' });
        return;
      }
      setError(String(body?.error || 'That did not work. Try again.'));
    } catch {
      setError('Could not reach Flizy. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-up mx-auto max-w-md">
      <p className="text-xs uppercase tracking-[0.18em] text-gold">Approve</p>

      {state.status === 'loading' ? <p className="mt-6 text-sm text-muted">Loading...</p> : null}

      {state.status === 'open' ? (
        <form onSubmit={onSubmit} className="card mt-6 space-y-5 p-6 md:p-8">
          <div>
            <h1 className="font-sans text-2xl tracking-wide text-paper">{state.title}</h1>
            {state.chatLabel ? <p className="mt-1 text-sm text-muted">For {state.chatLabel}</p> : null}
          </div>
          {state.lines.length ? (
            <div className="space-y-1 font-mono text-[13px] leading-relaxed text-paper">
              {state.lines.map((line, i) => (
                <p key={i} className="m-0 break-words">
                  {line}
                </p>
              ))}
            </div>
          ) : null}
          <div>
            <label className="label" htmlFor="approval-pin">
              Your PIN
            </label>
            <input
              id="approval-pin"
              className="input font-mono"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={12}
              value={pin}
              onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, '').slice(0, 12));
                if (error) setError('');
              }}
              autoFocus
              required
            />
            <p className="mt-1.5 text-xs text-muted">
              Only ever type your PIN here, on flizy.app. Flizy never asks for it in a chat.
            </p>
          </div>
          {error ? <div className="alert alert-error">{error}</div> : null}
          <button className="btn btn-primary w-full" type="submit" disabled={busy || pin.length < 4}>
            {busy ? 'Checking' : 'Approve'}
          </button>
        </form>
      ) : null}

      {state.status === 'approved' ? (
        <div className="card mt-6 space-y-2 p-6 md:p-8" role="status">
          <h1 className="font-sans text-2xl tracking-wide text-paper">Approved</h1>
          <p className="text-sm text-muted">
            Go back to {state.chatLabel || 'the chat'}. Flizy carries on there in a moment.
          </p>
        </div>
      ) : null}

      {state.status === 'locked' ? (
        <div className="card mt-6 space-y-2 p-6 md:p-8" role="alert">
          <h1 className="font-sans text-2xl tracking-wide text-paper">Paused</h1>
          <p className="text-sm text-muted">{state.message || 'Too many wrong PINs.'}</p>
          <p className="text-sm text-muted">Nothing happened. This link no longer works.</p>
        </div>
      ) : null}

      {state.status in CLOSED_COPY ? (
        <div className="card mt-6 p-6 md:p-8" role="status">
          <p className="text-sm text-muted">{CLOSED_COPY[state.status]}</p>
        </div>
      ) : null}
    </div>
  );
}
