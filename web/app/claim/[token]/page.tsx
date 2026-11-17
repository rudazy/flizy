'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { track } from '../../../lib/analytics';
import { formatClaimAmount } from '../../../lib/claimAmount.ts';
import { ShareClaimCard } from '../../../components/ShareClaimCard';
import { ClaimEmailVerify } from '../../../components/ClaimEmailVerify';
import type { ClaimShare } from '../../../lib/claimShareView.ts';

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

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Where on Account an identity of this kind is added and verified. */
const VERIFY_PLACE: Record<string, { href: string; label: string }> = {
  platform: { href: '/dashboard/account?s=platforms', label: 'Link it on Account, Platforms' },
  phone: { href: '/dashboard/account?s=chat', label: 'Link WhatsApp or Telegram with that number' },
};

/**
 * A payment held for someone, opened from its link. Signed out, it shows who
 * sent what, that it is testnet, and its expiry, with sign-up and sign-in:
 * nothing about who it was sent to. Signed in, the sender can share it, the
 * recipient can claim it, and anyone else is told which identity it was sent
 * to so they can add and verify it. The link never moves money on its own.
 */
export default function ClaimPage() {
  const params = useParams();
  const token = String(params.token || '');
  const [data, setData] = useState<ClaimView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

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

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="font-sans text-3xl tracking-wide text-paper">A payment for you</h1>

      {!data ? <p className="text-muted">Loading...</p> : null}
      {data?.error ? <p className="text-gold">{data.error}</p> : null}

      {data && !data.error ? (
        <div className="card space-y-4 p-6 text-sm">
          <p className="m-0 text-paper">
            {data.viewer === 'sender' ? 'You sent' : `${data.sender} sent you`}{' '}
            <span className="font-sans text-lg text-lime">{amount}</span> on Flizy.
          </p>
          <p className="m-0 text-xs text-muted">Testnet: these are test funds, not real money.</p>
          {data.expires_at ? <p className="m-0 text-xs text-muted">Can be claimed until {when(data.expires_at)}.</p> : null}

          {!pending ? (
            <p className="m-0 text-muted">
              {data.status === 'claimed' ? 'This payment has been received.' : 'This payment is no longer waiting to be claimed.'}
            </p>
          ) : !data.viewer ? (
            <div className="flex flex-col gap-2">
              <Link href={`/signup?next=${next}`} className="btn btn-primary no-underline">
                Create a Flizy account
              </Link>
              <Link href={`/login?next=${next}`} className="btn btn-ghost no-underline">
                Sign in
              </Link>
            </div>
          ) : data.viewer === 'sender' ? (
            data.share && data.claim_id ? (
              <ShareClaimCard claimId={data.claim_id} share={data.share} />
            ) : null
          ) : data.viewer === 'recipient' ? (
            data.can_claim_on_web ? (
              <button type="button" className="btn btn-primary w-full py-3 font-semibold" disabled={busy} onClick={() => void onClaim()}>
                {busy ? 'Receiving...' : 'Receive it in my Flizy wallet'}
              </button>
            ) : (
              <p className="m-0 text-muted">
                This was sent to your phone, so you receive it in WhatsApp or Telegram: send <span className="font-mono text-paper">flizy claim</span>.
              </p>
            )
          ) : (
            <div className="space-y-3">
              <p className="m-0 text-paper">
                This payment was sent to {data.sent_to || 'another identity'}. Add and verify it on your account to claim, then open this link again.
              </p>
              {data.recipient_kind === 'email' ? (
                <ClaimEmailVerify onVerified={() => void load()} />
              ) : data.recipient_kind && VERIFY_PLACE[data.recipient_kind] ? (
                <Link href={VERIFY_PLACE[data.recipient_kind].href} className="btn btn-ghost no-underline">
                  {VERIFY_PLACE[data.recipient_kind].label}
                </Link>
              ) : null}
            </div>
          )}

          {msg ? <div className={`alert text-sm ${msg.startsWith('Received') ? 'alert-ok' : 'alert-error'}`}>{msg}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
