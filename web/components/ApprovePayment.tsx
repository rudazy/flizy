'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CopyIcon, ShieldCheckIcon } from './ExploreIcons';
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

/** How long a link stays open. Matches lib/custody/approvals.js TTL_MS. */
const WINDOW_MS = 10 * 60 * 1000;

const CARD = {
  background:
    'radial-gradient(90% 32% at 50% 0%, rgba(92, 68, 16, 0.5) 0%, rgba(12, 11, 10, 0) 68%), radial-gradient(80% 24% at 50% 100%, rgba(70, 50, 12, 0.28) 0%, rgba(12, 11, 10, 0) 70%), #0c0b0a',
};

function secondsLeft(expiresAt: string, now: number): number {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
}

function clock(expiresAt: string, now: number): string {
  const s = secondsLeft(expiresAt, now);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Share of the ten minutes still left, for the bar under the clock. */
function remainingShare(expiresAt: string, now: number): number {
  const left = Math.max(0, new Date(expiresAt).getTime() - now);
  return Math.max(0, Math.min(100, (left / WINDOW_MS) * 100));
}

/** "≈ " plus a two-decimal USD amount. tUSD is one to one. ETH uses the mainnet rate. Anything else has no line. */
function usdLine(amount: string, asset: string, usdPerEth: number | null): string | null {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const upper = asset.toUpperCase();
  const usd = upper === 'TUSD' ? n : upper === 'ETH' && usdPerEth != null ? n * usdPerEth : null;
  if (usd == null) return null;
  return `≈ ${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}

function shortAddress(address: string): string {
  return address.length > 28 ? `${address.slice(0, 25)}...` : address;
}

/**
 * After the passkey. Submitted is the two lines on the sent screen.
 * Every other status stays one sentence, the same words as before, so a
 * reader still finds "Approved. Sending now.", "Sent." and
 * "Cancelled. Nothing was sent."
 */
function outcome(status: string): { title: string; body: string | null; wait: boolean } {
  if (status === 'submitted') {
    return { title: 'Sent to the network', body: 'Waiting for it to confirm. You will also get a message in chat.', wait: true };
  }
  if (status === 'signed' || status === 'sending') return { title: 'Approved. Sending now.', body: null, wait: true };
  if (status === 'sent') return { title: 'Sent.', body: null, wait: false };
  if (status === 'failed') return { title: 'It was approved, but could not be sent. Nothing moved.', body: null, wait: false };
  if (status === 'cancelled') return { title: 'Cancelled. Nothing was sent.', body: null, wait: false };
  if (status === 'expired') {
    return { title: 'Not approved in time, so nothing was sent. Start the payment again in chat.', body: null, wait: false };
  }
  return { title: 'This payment can no longer be approved.', body: null, wait: false };
}

export function ApprovePayment({ token, usdPerEth = null }: { token: string; usdPerEth?: number | null }) {
  const [view, setView] = useState<View | null>(null);
  const [state, setState] = useState<'loading' | 'signed-out' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'approve' | 'cancel'>('');
  const [now, setNow] = useState(() => Date.now());
  const expiredAsk = useRef<string | null>(null);

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
  // Once the clock hits zero, read the row again so the page stops offering Approve.
  useEffect(() => {
    if (!view || view.status !== 'pending') return;
    const ms = new Date(view.expiresAt).getTime() - Date.now();
    if (ms > 0) {
      const t = window.setTimeout(() => void load(), ms + 200);
      return () => window.clearTimeout(t);
    }
    if (expiredAsk.current === view.expiresAt) return;
    expiredAsk.current = view.expiresAt;
    void load();
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

  const pending = state === 'ready' && view?.status === 'pending';
  const done = state === 'ready' && view && view.status !== 'pending' ? outcome(view.status) : null;
  const dollars = view ? usdLine(view.amount, view.asset, usdPerEth) : null;

  return (
    <div className="fade-up mx-auto w-full max-w-[460px]">
      <div
        className="rounded-[22px] border border-[#4a3b1c] px-3.5 py-6 shadow-[0_0_0_1px_rgba(247,208,71,0.05),0_0_80px_rgba(247,208,71,0.07),0_28px_80px_rgba(0,0,0,0.5)] sm:px-5"
        style={CARD}
      >
        <p className="m-0 font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-sun">Passkey approval</p>
        <h1 className="m-0 mt-3 font-sans text-[30px] font-bold leading-[1.1] tracking-tight text-white sm:text-[34px]">
          Approve this <span className="text-sun">payment</span>
        </h1>
        <p className="m-0 mt-2 font-sans text-[15px] leading-relaxed text-[#b7b1a8]">
          Use your passkey to securely approve this transaction.
        </p>

        {state === 'loading' ? <p className="mt-5 font-sans text-[14px] text-[#b7b1a8]">Loading the payment.</p> : null}

        {state === 'signed-out' ? (
          <div className="mt-5 grid gap-3">
            <p className="m-0 font-sans text-[14px] text-[#b7b1a8]">Log in with the account that made this payment to see and approve it.</p>
            <Link
              href={`/login?next=${encodeURIComponent(`/approve/${token}`)}`}
              className="btn-sun flex h-[54px] items-center justify-center rounded-[14px] font-sans text-[16px] font-semibold no-underline"
            >
              Log in
            </Link>
          </div>
        ) : null}

        {state === 'error' ? <p className="mt-5 font-sans text-[14px] text-[#e0b070]">{error}</p> : null}

        {state === 'ready' && view ? (
          <div className="mt-5 grid gap-4">
            <dl className="m-0 overflow-hidden rounded-[16px] border border-[#2a2a2e] bg-[#101011]">
              <Detail label={pending ? 'Recipient' : 'To'}>
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    {view.recipientLabel ? <p className="m-0 truncate font-sans text-[15px] font-semibold text-white">{view.recipientLabel}</p> : null}
                    <p className={`m-0 font-mono text-[12px] leading-snug text-[#c4beb4] ${pending ? 'break-all' : 'truncate'}`}>
                      {pending ? view.recipientAddress : shortAddress(view.recipientAddress)}
                    </p>
                  </div>
                  <CopyButton text={view.recipientAddress} />
                </div>
              </Detail>
              {pending ? (
                <Detail label="Network">
                  <NetworkName />
                </Detail>
              ) : null}
              <Detail label="Amount">
                <p className="m-0 font-sans text-[26px] font-bold leading-none tracking-tight text-white">{view.amount}</p>
                {dollars ? <p className="m-0 mt-1 font-sans text-[13px] text-[#9a958c]">{dollars}</p> : null}
              </Detail>
              {pending ? (
                <Detail label="Expires in" last>
                  <p className="m-0 font-sans text-[22px] font-bold leading-none text-sun">{clock(view.expiresAt, now)}</p>
                  <span className="mt-2.5 block h-1 w-full max-w-[220px] overflow-hidden rounded-full bg-[#2a2a2e]">
                    <span className="block h-full rounded-full bg-sun" style={{ width: `${remainingShare(view.expiresAt, now)}%` }} />
                  </span>
                </Detail>
              ) : (
                <Detail label="Network" last>
                  <NetworkName />
                </Detail>
              )}
            </dl>

            {pending ? (
              <div className="rounded-[14px] border border-[#6a5420] border-l-4 border-l-sun bg-[#14110a] px-4 py-3.5">
                <p className="m-0 font-sans text-[15px] font-semibold text-white">One-time permission</p>
                <p className="m-0 mt-1 font-sans text-[13.5px] leading-relaxed text-[#b7b1a8]">
                  This is more than your passkey allows each day. Approving signs a permission for this one payment only: this
                  recipient, this amount, once, for the next few minutes.
                </p>
              </div>
            ) : done ? (
              <div className="flex items-center gap-3.5 rounded-[14px] border border-[#6a5420] bg-[#14110a] px-4 py-4 shadow-[0_0_28px_rgba(247,208,71,0.06)]" role="status">
                {done.wait ? <WaitRing /> : null}
                <div className="min-w-0">
                  <p className="m-0 font-sans text-[15px] font-semibold text-white">{done.title}</p>
                  {done.body ? <p className="m-0 mt-0.5 font-sans text-[13.5px] leading-relaxed text-[#b7b1a8]">{done.body}</p> : null}
                </div>
              </div>
            ) : null}

            {pending ? (
              <button
                type="button"
                onClick={() => void approve()}
                disabled={busy !== ''}
                className="btn-sun h-[54px] w-full rounded-[14px] font-sans text-[16px] font-semibold disabled:opacity-50"
              >
                {busy === 'approve' ? 'Waiting for your passkey' : 'Approve with passkey'}
              </button>
            ) : null}

            {view.txHash && (view.status === 'sent' || view.status === 'submitted') ? (
              <a
                href={`${CUSTODY_DOOR_CHAIN.explorerUrl}/tx/${view.txHash}`}
                target="_blank"
                rel="noreferrer noopener"
                className="btn-sun flex h-[54px] w-full items-center justify-center rounded-[14px] font-sans text-[16px] font-semibold no-underline"
              >
                View the transaction
              </a>
            ) : null}

            {view.status === 'pending' || view.status === 'signed' ? (
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={busy !== ''}
                className="h-[54px] w-full rounded-[14px] border border-[#3a3834] bg-transparent font-sans text-[16px] font-medium text-white hover:bg-[#161614] disabled:opacity-50"
              >
                {busy === 'cancel' ? 'Cancelling' : 'Cancel payment'}
              </button>
            ) : (
              <Link
                href="/dashboard/wallet"
                className="flex h-[54px] w-full items-center justify-center rounded-[14px] border border-[#3a3834] bg-transparent font-sans text-[16px] font-medium text-white no-underline hover:bg-[#161614]"
              >
                Back to wallet
              </Link>
            )}

            {error ? (
              <p className="m-0 font-sans text-[13px] text-[#e0b070]" role="alert">
                {error}
              </p>
            ) : null}

            {pending ? (
              <div className="flex items-start gap-3 px-1 pt-1">
                <ShieldCheckIcon size={22} className="mt-0.5 shrink-0 text-[#8d867c]" />
                <div>
                  <p className="m-0 font-sans text-[13.5px] text-[#d9d4ca]">Protected by your passkey</p>
                  <p className="m-0 font-sans text-[12.5px] text-[#8d867c]">Secure. Private. Only you can approve.</p>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Detail({ label, children, last = false }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div className={`grid grid-cols-[82px_minmax(0,1fr)] items-center gap-2 px-3 py-3.5 ${last ? '' : 'border-b border-[#26262a]'}`}>
      <dt className="font-sans text-[14px] text-[#9a958c]">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

function NetworkName() {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-sans text-[15px] font-semibold text-white">{CUSTODY_DOOR_CHAIN.name}</span>
      {CUSTODY_DOOR_CHAIN.id === 91342 ? (
        <span className="rounded-[6px] bg-[#2a2a2e] px-2 py-0.5 font-sans text-[12px] text-[#c8c2b8]">Testnet</span>
      ) : null}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : 'Copy address'}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border border-[#3a3834] bg-[#141416] ${copied ? 'text-sun' : 'text-[#d9d4ca] hover:text-white'}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).catch(() => undefined);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      <CopyIcon size={16} />
    </button>
  );
}

/** A gold arc on a dim ring, while the network has not confirmed yet. */
function WaitRing() {
  return (
    <svg className="h-12 w-12 shrink-0 animate-spin" viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r="16" fill="none" stroke="#3a3424" strokeWidth="3" />
      <circle cx="22" cy="22" r="16" fill="none" stroke="#f7d047" strokeWidth="3" strokeLinecap="round" strokeDasharray="28 100" />
    </svg>
  );
}
