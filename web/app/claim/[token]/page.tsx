'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { track } from '../../../lib/analytics';
import { formatClaimAmount } from '../../../lib/claimAmount.ts';
import { ShareClaimCard } from '../../../components/ShareClaimCard';
import { ClaimEmailVerify } from '../../../components/ClaimEmailVerify';
import type { ClaimShare } from '../../../lib/claimShareView.ts';
import { emailFromHash, emailHashSuffix } from '../../../lib/emailHint.ts';

type ClaimView = {
  error?: string;
  amount_eth?: string;
  asset?: string;
  nft_token_id?: string | null;
  status?: string;
  sender?: string;
  testnet?: boolean;
  expires_at?: string | null;
  /** Only for a signed-in viewer. */
  viewer?: 'sender' | 'recipient' | 'other';
  claim_id?: string;
  share?: ClaimShare | null;
  can_claim_on_web?: boolean;
  recipient_kind?: 'phone' | 'email' | 'platform';
  sent_to?: string | null;
};

/** 16 Feb 2027, 14:30, in the reader's own time. */
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "0.01 ETH" as the number and the asset, so the asset can be drawn in gold. */
function amountParts(text: string): [string, string] {
  const at = text.lastIndexOf(' ');
  return at > 0 ? [text.slice(0, at), text.slice(at + 1)] : [text, ''];
}

const CARD = 'rounded-[12px] border border-chrome-line bg-[#0e0e0f] p-5';

/** Where on Account an identity of this kind is added and verified. */
const VERIFY_PLACE: Record<string, { href: string; label: string }> = {
  platform: { href: '/dashboard/account?s=platforms', label: 'Link it on Account, Platforms' },
  phone: { href: '/dashboard/account?s=chat', label: 'Link WhatsApp or Telegram with that number' },
};

/**
 * A payment held for someone, opened from its link. Signed out, it shows who
 * sent what and its expiry, with sign-up and sign-in: nothing about who it was
 * sent to. Signed in, the sender can share it, the
 * recipient can claim it, and anyone else is told which identity it was sent
 * to so they can add and verify it. The link never moves money on its own.
 *
 * The claim email's link carries the address after the # (#to=). It is read
 * once, taken out of the address bar, and only fills in the email on sign-up,
 * sign-in and the add-email form.
 */
export default function ClaimPage() {
  const params = useParams();
  const token = String(params.token || '');
  const [data, setData] = useState<ClaimView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [toHint, setToHint] = useState('');

  useEffect(() => {
    const hint = emailFromHash(window.location.hash, 'to');
    if (!window.location.hash) return;
    setToHint(hint);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    const res = await fetch(`/api/claim/${token}`, { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    setData(res.ok ? json : { error: json.error || 'Claim not found' });
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

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
      if (!res.ok) {
        setMsg(json.error || 'Could not claim.');
        return;
      }
      track('claim_completed');
      setMsg('Received. The funds are in your Flizy wallet.');
      await load();
    } catch {
      setMsg('Could not claim. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const next = encodeURIComponent(`/claim/${token}`);
  const amount = data && !data.error ? formatClaimAmount({ amount_eth: data.amount_eth, asset: data.asset, nft_token_id: data.nft_token_id }) : '';
  const pending = data?.status === 'pending';

  const [number, asset] = amountParts(amount);
  const isSender = data?.viewer === 'sender';
  const subtitle = !data || data.error
    ? ''
    : isSender
      ? pending
        ? "You've sent a payment on Flizy that can be claimed."
        : 'A payment you sent on Flizy.'
      : `${data.sender} sent you a payment on Flizy.`;

  return (
    <div className="mx-auto w-full max-w-[560px] space-y-5 font-sans">
      <header>
        <h1 className="m-0 text-[30px] font-semibold leading-tight tracking-wide text-paper sm:text-[34px]">A payment for you</h1>
        {subtitle ? <p className="m-0 mt-2 text-[15px] text-[#bdb6ab]">{subtitle}</p> : null}
      </header>

      {!data ? <p className="text-muted">Loading...</p> : null}
      {data?.error ? <p className="text-gold">{data.error}</p> : null}

      {data && !data.error ? (
        <>
          <div className="relative overflow-hidden rounded-[12px] border border-sun/30 bg-[linear-gradient(135deg,#16140d_0%,#0e0d0a_60%,#0b0a09_100%)] p-5">
            <span
              aria-hidden
              className="pointer-events-none absolute -right-[440px] -top-10 h-[520px] w-[520px] rounded-full border border-sun/45 shadow-[0_0_48px_rgba(247,208,71,0.16)]"
            />
            <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_92%_20%,rgba(247,208,71,0.10),transparent_55%)]" />
            <div className={`relative grid gap-4 ${data.expires_at ? 'grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]' : ''}`}>
              <div>
                <p className="m-0 text-[14px] text-[#bdb6ab]">{isSender ? 'Amount sent' : 'Amount'}</p>
                <p className="m-0 mt-1 whitespace-nowrap text-[28px] font-semibold leading-tight tracking-wide text-paper sm:text-[40px]">
                  {number} {asset ? <span className="text-sun">{asset}</span> : null}
                </p>
              </div>
              {data.expires_at ? (
                <div className="border-l border-chrome-line pl-4">
                  <p className="m-0 text-[14px] text-[#bdb6ab]">Expires</p>
                  <p className="m-0 mt-2 text-[15px] font-semibold text-paper sm:text-[18px]">{when(data.expires_at)}</p>
                </div>
              ) : null}
            </div>
          </div>

          <div className={CARD}>
            {!pending ? (
              <p className="m-0 text-[15px] text-[#d8d2c8]">
                {data.status === 'claimed' ? 'This payment has been received.' : 'This payment is no longer waiting to be claimed.'}
              </p>
            ) : !data.viewer ? (
              <div className="grid gap-4">
                <div>
                  <h2 className="m-0 text-[22px] font-semibold tracking-wide text-paper">Receive this payment</h2>
                  <p className="m-0 mt-1 text-[14px] text-[#bdb6ab]">Create a Flizy account with the email it was sent to, or sign in to yours.</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Link href={`/signup?next=${next}${emailHashSuffix(toHint)}`} className="btn btn-primary min-h-[48px] no-underline">
                    Create a Flizy account
                  </Link>
                  <Link href={`/login?next=${next}${emailHashSuffix(toHint)}`} className="btn btn-ghost min-h-[48px] no-underline">
                    Sign in
                  </Link>
                </div>
              </div>
            ) : isSender ? (
              data.share && data.claim_id ? (
                <ShareClaimCard claimId={data.claim_id} share={data.share} page />
              ) : null
            ) : data.viewer === 'recipient' ? (
              data.can_claim_on_web ? (
                <div className="grid gap-4">
                  <h2 className="m-0 text-[22px] font-semibold tracking-wide text-paper">It is for you</h2>
                  <button type="button" className="btn btn-primary min-h-[48px] w-full font-semibold" disabled={busy} onClick={() => void onClaim()}>
                    {busy ? 'Receiving...' : 'Receive it in my Flizy wallet'}
                  </button>
                </div>
              ) : (
                <p className="m-0 text-[15px] text-[#d8d2c8]">
                  This was sent to your phone, so you receive it in WhatsApp or Telegram: send <span className="font-mono text-paper">flizy claim</span>.
                </p>
              )
            ) : (
              <div className="grid gap-3">
                <h2 className="m-0 text-[22px] font-semibold tracking-wide text-paper">Add the address it was sent to</h2>
                <p className="m-0 text-[14px] text-[#bdb6ab]">
                  This payment was sent to {data.sent_to || 'another identity'}. Add and verify it on your account to claim, then open this link again.
                </p>
                {data.recipient_kind === 'email' ? (
                  <ClaimEmailVerify initialEmail={toHint} onVerified={() => void load()} />
                ) : data.recipient_kind && VERIFY_PLACE[data.recipient_kind] ? (
                  <Link href={VERIFY_PLACE[data.recipient_kind].href} className="btn btn-ghost no-underline">
                    {VERIFY_PLACE[data.recipient_kind].label}
                  </Link>
                ) : null}
              </div>
            )}

            {msg ? <div className={`alert mt-4 text-sm ${msg.startsWith('Received') ? 'alert-ok' : 'alert-error'}`}>{msg}</div> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
