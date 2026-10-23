'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CUSTODY_DOOR_CHAIN } from '../lib/custodyDoor';

/**
 * Approve one chat payment over the daily passkey limit.
 *
 * Shows what the server holds for this account and token (recipient, address,
 * asset, amount, expiry), never anything from the URL. Approve signs a one-off
 * permission for exactly that payment with the passkey; the bot host's relayer
 * then sends it, and this page follows it to sent. Cancel closes it.
 */

type View = {
  status: string;
  asset: string;
  amount: string;
  recipientLabel: string | null;
  recipientAddress: string;
  expiresAt: string;
  txHash: string | null;
};

const b64 = (buf: ArrayBuffer) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64 = (text: string) => {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

const STATUS_COPY: Record<string, string> = {
  signed: 'Approved. Sending now.',
  sending: 'Approved. Sending now.',
  submitted: 'Sent to the network. Waiting for it to confirm. You will also get a message in chat.',
  sent: 'Sent.',
  failed: 'It was approved, but could not be sent. Nothing moved.',
  cancelled: 'Cancelled. Nothing was sent.',
  expired: 'Not approved in time, so nothing was sent. Start the payment again in chat.',
};

function left(expiresAt: string, now: number): string {
  const s = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function ApprovePayment({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<'loading' | 'signed-out' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'approve' | 'cancel'>('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/custody/approvals/${encodeURIComponent(token)}`, { cache: 'no-store' });
      if (res.status === 401) return setState('signed-out');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'This approval could not be opened.');
        return setState('error');
      }
      setView(data as View);
      setState('ready');
    } catch {
      setError('This approval could not be opened.');
      setState('error');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // The countdown, and following an approved payment until it settles.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    if (!view || !['signed', 'sending', 'submitted'].includes(view.status)) return;
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [view, load]);

  async function post(body: unknown) {
    const res = await fetch(`/api/custody/approvals/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Something went wrong. Try again.');
    return data;
  }

  async function approve() {
    setError('');
    setBusy('approve');
    try {
      const { challenge, keyIds } = (await post({ action: 'begin' })) as { challenge: string; keyIds: string[] };
      const got = (await navigator.credentials.get({
        publicKey: {
          challenge: fromB64(challenge),
          rpId: window.location.hostname,
          allowCredentials: keyIds.map((id) => ({ type: 'public-key' as const, id: fromB64(id) })),
          userVerification: 'required',
        },
      })) as PublicKeyCredential | null;
      if (!got) throw new Error('The payment was not approved.');
      const a = got.response as AuthenticatorAssertionResponse;
      await post({
        action: 'finish',
        credentialId: b64(got.rawId),
        authenticatorData: b64(a.authenticatorData),
        clientDataJSON: b64(a.clientDataJSON),
        signature: b64(a.signature),
      });
    } catch (err) {
      setError(err instanceof Error && err.name !== 'NotAllowedError' ? err.message : 'The payment was not approved.');
    } finally {
      setBusy('');
      await load();
    }
  }

  async function cancel() {
    setError('');
    setBusy('cancel');
    try {
      await post({ action: 'cancel' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'It could not be cancelled.');
    } finally {
      setBusy('');
      await load();
    }
  }

  return (
    <div className="fade-up mx-auto w-full max-w-[480px] px-4 py-8">
      <div className="rounded-[18px] border border-[#2e2818] bg-[#0b0b0b] p-5">
        <p className="m-0 font-mono text-[10.5px] font-medium uppercase tracking-[0.24em] text-sun">Passkey approval</p>
        <h1 className="m-0 mt-2 font-sans text-[26px] font-bold text-white">Approve this payment</h1>

        {state === 'loading' ? <p className="mt-4 font-sans text-[14px] text-[#b7b1a8]">Loading the payment.</p> : null}

        {state === 'signed-out' ? (
          <div className="mt-4 grid gap-3">
            <p className="m-0 font-sans text-[14px] text-[#b7b1a8]">Log in with the account that made this payment to see and approve it.</p>
            <Link
              href={`/login?next=${encodeURIComponent(`/approve/${token}`)}`}
              className="btn-sun flex h-[44px] items-center justify-center rounded-[10px] font-sans text-[14px] font-semibold no-underline"
            >
              Log in
            </Link>
          </div>
        ) : null}

        {state === 'error' ? <p className="mt-4 font-sans text-[14px] text-[#e0b070]">{error}</p> : null}

        {state === 'ready' && view ? (
          <div className="mt-4 grid gap-4">
            <dl className="m-0 grid gap-3 rounded-[14px] border border-[#2e2e33] bg-[#0f0f10] p-4 font-sans text-[14px]">
              <div className="grid gap-1">
                <dt className="text-[#9a958c]">To</dt>
                <dd className="m-0 text-white">
                  {view.recipientLabel ? <span className="block font-semibold">{view.recipientLabel}</span> : null}
                  <span className="block break-all font-mono text-[12.5px] text-[#d9d4ca]">{view.recipientAddress}</span>
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-[#9a958c]">Amount</dt>
                <dd className="m-0 text-[20px] font-semibold text-white">{view.amount}</dd>
              </div>
              {view.status === 'pending' ? (
                <div className="grid gap-1">
                  <dt className="text-[#9a958c]">Time left to approve</dt>
                  <dd className="m-0 font-mono text-white">{left(view.expiresAt, now)}</dd>
                </div>
              ) : null}
            </dl>

            {view.status === 'pending' ? (
              <>
                <p className="m-0 font-sans text-[13px] leading-relaxed text-[#b7b1a8]">
                  This is more than your passkey allows each day. Approving signs a permission for this one payment only: this
                  recipient, this amount, once, for the next few minutes.
                </p>
                <button
                  type="button"
                  onClick={() => void approve()}
                  disabled={busy !== ''}
                  className="btn-sun h-[48px] rounded-[10px] font-sans text-[15px] font-semibold disabled:opacity-50"
                >
                  {busy === 'approve' ? 'Waiting for your passkey' : 'Approve with passkey'}
                </button>
              </>
            ) : (
              <p className="m-0 font-sans text-[14px] text-white" role="status">
                {STATUS_COPY[view.status] || 'This payment can no longer be approved.'}
              </p>
            )}

            {view.txHash && (view.status === 'sent' || view.status === 'submitted') ? (
              <a
                href={`${CUSTODY_DOOR_CHAIN.explorerUrl}/tx/${view.txHash}`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-sans text-[13px] text-sun no-underline hover:opacity-80"
              >
                View the transaction
              </a>
            ) : null}

            {view.status === 'pending' || view.status === 'signed' ? (
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={busy !== ''}
                className="h-[44px] rounded-[10px] border border-[#3a3833] bg-[#0c0b0a] font-sans text-[14px] text-white hover:opacity-80 disabled:opacity-50"
              >
                {busy === 'cancel' ? 'Cancelling' : 'Cancel payment'}
              </button>
            ) : null}

            {error ? (
              <p className="m-0 font-sans text-[13px] text-[#e0b070]" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
