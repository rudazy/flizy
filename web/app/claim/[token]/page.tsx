'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { track } from '../../../lib/analytics';
import { CopyButton } from '../../../components/CopyButton';
import { claimSharePath, claimShareText, telegramShareHref } from '../../../lib/claimShare.ts';

type ClaimView = {
  amount_eth?: string;
  status?: string;
  error?: string;
  recipient?: string;
  recipient_kind?: string;
  can_claim_on_web?: boolean;
  to_wa_hint?: string;
  carries_invite?: boolean;
};

export default function ClaimPage() {
  const params = useParams();
  const token = String(params.token || '');
  const inviteRef = String(params.ref || '');
  const [origin, setOrigin] = useState('');
  const [data, setData] = useState<ClaimView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [payerHandle, setPayerHandle] = useState('');

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
    setOrigin(window.location.origin);
  }, []);

  const shareUrl = useMemo(() => {
    const path = claimSharePath(token, inviteRef);
    if (!path || !origin) return '';
    return `${origin}${path}`;
  }, [origin, token, inviteRef]);

  const tgShare = shareUrl
    ? telegramShareHref(shareUrl, claimShareText(shareUrl, data?.amount_eth))
    : '';

  useEffect(() => {
    fetch('/api/dashboard', { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) {
          setLoggedIn(false);
          return;
        }
        const body = await r.json().catch(() => ({}));
        const mine = String(body?.account?.username || '').toLowerCase();
        if (mine) setPayerHandle(`@${mine}`);
        setLoggedIn(true);
      })
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
      track('claim_completed');
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
  const isPhone = data?.recipient_kind === 'phone';
  const canWeb = Boolean(data?.can_claim_on_web);

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="font-sans text-3xl tracking-wide text-paper">Claim funds</h1>
      <p className="text-sm text-muted">
        Money held for a phone or platform. Phone holds are claimed in WhatsApp or Telegram after
        that number is proven on that chat. Platform holds can be claimed here after you link.
      </p>
      {loggedIn === null ? <p className="text-sm text-muted">Checking your account…</p> : null}
      {loggedIn ? (
        <p className="text-sm text-muted">
          {payerHandle
            ? `Signed in as ${payerHandle}.`
            : 'Signed in. This claim pays out to your Flizy wallet.'}
        </p>
      ) : null}

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
              {isPhone ? (
                <span className="mt-1 block text-xs">
                  (Phone — claim only in WhatsApp or Telegram)
                </span>
              ) : null}
            </p>
          ) : null}

          {pending && shareUrl ? (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="break-all font-mono text-xs text-paper">{shareUrl}</p>
              <div className="flex flex-wrap gap-2">
                <CopyButton value={shareUrl} label="Copy link" />
                {tgShare ? (
                  <a
                    href={tgShare}
                    className="btn btn-ghost text-sm no-underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Share on Telegram
                  </a>
                ) : null}
              </div>
            </div>
          ) : null}

          {data.carries_invite && pending ? (
            <p className="text-xs text-muted">
              The sender invited you. Create an account from this page to be attributed. It
              counts for them after you finish setup, bind a verified phone, and complete a
              transfer (claiming this hold counts).
            </p>
          ) : null}

          {msg ? (
            <div
              className={`alert text-sm ${
                claimed || msg.includes('received') ? 'alert-ok' : 'alert-error'
              }`}
            >
              {msg}
            </div>
          ) : null}

          {pending && isPhone ? (
            <>
              <ol className="list-decimal space-y-2 pl-4 text-muted">
                {loggedIn ? null : <li>Create or log in to your Flizy account</li>}
                <li>Link WhatsApp or Telegram from the dashboard (with this number proven)</li>
                <li>
                  In that chat send <span className="font-mono text-paper">flizy claim</span>
                </li>
              </ol>
              <div className="flex flex-col gap-2">
                {loggedIn === false ? (
                  <>
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
                  </>
                ) : null}
                {loggedIn ? (
                  <Link href="/dashboard/account?s=chat" className="btn btn-primary no-underline">
                    Open chat link options
                  </Link>
                ) : null}
              </div>
              <p className="text-xs text-muted">
                Web payout is off for phone holds on purpose — the number is proven only in chat.
              </p>
            </>
          ) : null}

          {pending && canWeb ? (
            <>
              <ol className="list-decimal space-y-2 pl-4 text-muted">
                {loggedIn ? null : <li>Create or log in to your Flizy account</li>}
                <li>Link the matching platform (Account → Platforms)</li>
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
              ) : null}
              {loggedIn === false ? (
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
              ) : null}
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
