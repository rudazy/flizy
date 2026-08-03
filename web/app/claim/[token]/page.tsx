'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type ClaimView = {
  amount_eth?: string;
  status?: string;
  error?: string;
  recipient?: string;
  recipient_kind?: string;
  to_wa_hint?: string;
};

export default function ClaimPage() {
  const params = useParams();
  const token = String(params.token || '');
  const [data, setData] = useState<ClaimView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`/api/claim/${token}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setData({ error: json.error || 'Claim not found' });
      return;
    }
    setData(json);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetch('/api/dashboard')
      .then((r) => setLoggedIn(r.ok))
      .catch(() => setLoggedIn(false));
  }, []);

  async function onClaim() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch('/api/claim/payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401) {
        setMsg('Log in first, then claim.');
        window.location.href = `/login?next=${encodeURIComponent(`/claim/${token}`)}`;
        return;
      }
      if (!res.ok) {
        setMsg(json.error || 'Could not claim.');
        return;
      }
      setMsg('Claim received. Funds are in your Flizy wallet.');
      await load();
    } catch {
      setMsg('Could not claim. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const pending = data && !data.error && data.status === 'pending';
  const claimed = data?.status === 'claimed';

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="font-sans text-3xl tracking-wide text-paper">Claim funds</h1>
      <p className="text-sm text-muted">
        Money held for a phone or platform identity. You receive it after proving that identity on
        Flizy — then claim here or in chat.
      </p>

      {!data ? <p className="text-muted">Loading…</p> : null}
      {data?.error ? <p className="text-gold">{data.error}</p> : null}

      {data && !data.error ? (
        <div className="card space-y-4 p-6 text-sm">
          <p>
            Amount:{' '}
            <span className="font-sans text-lg text-lime">{data.amount_eth} ETH</span>
          </p>
          <p className="text-muted">
            Status: <span className="text-paper">{data.status}</span>
          </p>
          {data.recipient ? (
            <p className="text-muted">
              Held for: <span className="text-paper">{data.recipient}</span>
            </p>
          ) : null}

          {msg ? (
            <div className={`alert text-sm ${claimed || msg.includes('received') ? 'alert-ok' : 'alert-error'}`}>
              {msg}
            </div>
          ) : null}

          {pending ? (
            <>
              <ol className="list-decimal space-y-2 pl-4 text-muted">
                <li>Create or log in to your Flizy account</li>
                <li>
                  Prove the identity this claim is for (link chat with phone, or link GitHub on
                  Account → Platforms)
                </li>
                <li>Claim below — or in chat: flizy claim</li>
              </ol>

              {loggedIn ? (
                <button
                  type="button"
                  className="btn btn-primary w-full py-3 font-semibold"
                  disabled={busy}
                  onClick={() => void onClaim()}
                >
                  {busy ? 'Claiming…' : 'Claim to my wallet'}
                </button>
              ) : (
                <div className="flex flex-col gap-2">
                  <Link
                    href={`/signup?next=${encodeURIComponent(`/claim/${token}`)}`}
                    className="btn btn-primary no-underline"
                  >
                    Create account
                  </Link>
                  <Link
                    href={`/login?next=${encodeURIComponent(`/claim/${token}`)}`}
                    className="btn btn-ghost no-underline"
                  >
                    Log in
                  </Link>
                </div>
              )}

              <p className="text-xs text-muted">
                Prefer chat? After linking, send{' '}
                <span className="font-mono text-paper">flizy claim</span> (or{' '}
                <span className="font-mono text-paper">/claim</span> on Telegram).
              </p>
            </>
          ) : null}

          {claimed ? (
            <div className="space-y-2">
              <p className="text-lime">This claim has been paid out.</p>
              <Link href="/dashboard?s=recent" className="btn btn-ghost no-underline">
                Open dashboard
              </Link>
            </div>
          ) : null}

          {data.status && data.status !== 'pending' && data.status !== 'claimed' ? (
            <p className="text-muted">This claim is {data.status}.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
