'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export function PayLanding({
  refSlug,
  username,
  displayName,
}: {
  refSlug: string;
  username: string | null;
  displayName: string | null;
}) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [self, setSelf] = useState(false);
  const [amount, setAmount] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [explorer, setExplorer] = useState('');
  const [firstPay, setFirstPay] = useState(false);
  const [alreadySaved, setAlreadySaved] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSkipped, setSaveSkipped] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const handle = username ? `@${username}` : 'this Flizy account';
  const next = `/pay/${encodeURIComponent(refSlug)}`;

  useEffect(() => {
    fetch('/api/dashboard', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          setLoggedIn(false);
          return;
        }
        const body = await res.json().catch(() => ({}));
        setLoggedIn(true);
        const mine = String(body?.account?.username || '').toLowerCase();
        if (username && mine === username.toLowerCase()) {
          setSelf(true);
          return;
        }
        const prev = await fetch(`/api/pay/preview?ref=${encodeURIComponent(refSlug)}`, {
          cache: 'no-store',
        });
        const info = await prev.json().catch(() => ({}));
        if (prev.ok) {
          setFirstPay(Boolean(info.firstPay));
          setAlreadySaved(Boolean(info.alreadySaved));
        }
      })
      .catch(() => setLoggedIn(false));
  }, [username, refSlug]);

  async function onPay(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    setOk(false);
    try {
      const res = await fetch('/api/pay/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: refSlug, amount, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent(next)}`;
        return;
      }
      if (!res.ok) {
        setMsg(body.error || 'Could not pay.');
        return;
      }
      setOk(true);
      setExplorer(body.explorerUrl || '');
      setMsg('Paid.');
      setPassword('');
      if (body.alreadySaved === true) setAlreadySaved(true);
      else setAlreadySaved(false);
    } catch {
      setMsg('Could not pay. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fade-up mx-auto max-w-md space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Pay</p>
        <h1 className="mt-3 font-sans text-3xl tracking-wide text-paper">
          {displayName || handle}
        </h1>
        {displayName && username ? (
          <p className="mt-1 font-mono text-sm text-muted">@{username}</p>
        ) : null}
      </div>

      {self ? (
        <p className="text-sm text-muted">This is your pay page. Share the QR or @username.</p>
      ) : null}

      {loggedIn === false ? (
        <div className="flex flex-col gap-2">
          <Link
            href={`/login?next=${encodeURIComponent(next)}`}
            className="btn btn-primary no-underline"
          >
            Log in to pay
          </Link>
          <Link
            href={`/signup?next=${encodeURIComponent(next)}`}
            className="btn btn-ghost no-underline"
          >
            Create account
          </Link>
        </div>
      ) : null}

      {loggedIn && !self && !ok ? (
        <form onSubmit={onPay} className="card space-y-4 p-6">
          {firstPay ? (
            <div className="alert alert-warn text-sm">
              First payment. You have not paid {handle} before. Confirm the name
              before you send.
            </div>
          ) : null}
          <div>
            <label className="label" htmlFor="pay-amount">
              Amount (ETH)
            </label>
            <input
              id="pay-amount"
              className="input"
              inputMode="decimal"
              placeholder="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="pay-password">
              Account password
            </label>
            <input
              id="pay-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
          <button type="submit" className="btn btn-primary w-full py-3 font-semibold" disabled={busy}>
            {busy ? 'Paying…' : `Pay ${handle}`}
          </button>
        </form>
      ) : null}

      {loggedIn && !self && ok ? (
        <div className="card space-y-4 p-6">
          <div className="alert alert-ok text-sm">{justSaved ? `Saved ${handle} for later send.` : 'Paid.'}</div>
          {explorer ? (
            <a
              href={explorer}
              className="text-sm text-lime no-underline hover:text-gold"
              target="_blank"
              rel="noreferrer"
            >
              View receipt
            </a>
          ) : null}
          {!alreadySaved && !saveSkipped ? (
            <div className="space-y-3 border-t border-[var(--border)] pt-4">
              <p className="text-sm text-paper">
                Save {handle} as a trusted contact so the next send is just their name.
              </p>
              <button
                type="button"
                className="btn btn-primary w-full py-3 font-semibold"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  setMsg('');
                  try {
                    const res = await fetch('/api/pay/save', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ ref: refSlug }),
                    });
                    const body = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(body.error || 'Could not save');
                    setAlreadySaved(true);
                    setJustSaved(true);
                  } catch (err) {
                    setMsg(err instanceof Error ? err.message : 'Could not save');
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? 'Saving…' : `Save ${handle} for later`}
              </button>
              <button
                type="button"
                className="btn btn-ghost w-full text-sm"
                disabled={saving}
                onClick={() => setSaveSkipped(true)}
              >
                Skip
              </button>
              {msg ? <div className="alert alert-error text-sm">{msg}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
