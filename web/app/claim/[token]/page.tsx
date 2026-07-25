'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

export default function ClaimPage() {
  const params = useParams();
  const token = String(params.token || '');
  const [data, setData] = useState<{
    amount_eth?: string;
    status?: string;
    error?: string;
    to_wa_hint?: string;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/claim/${token}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ error: 'Failed to load claim' }));
  }, [token]);

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="font-sans text-3xl tracking-wide">Claim funds</h1>
      {!data ? <p className="text-muted">Loading...</p> : null}
      {data?.error ? <p className="text-gold">{data.error}</p> : null}
      {data && !data.error ? (
        <div className="card space-y-3 p-6 text-sm">
          <p>
            Amount: <span className="text-lime">{data.amount_eth} ETH</span>
          </p>
          <p className="text-muted">Status: {data.status}</p>
          <p className="text-muted">
            Funds are reserved for a specific phone number. They only unlock once that number is
            proven on a Flizy account (not email signup alone). WhatsApp or Telegram both work.
          </p>
          {data.status === 'pending' ? (
            <>
              <p className="text-muted">
                1. Create or log in to your Flizy account
                <br />
                2. Link WhatsApp or Telegram from the dashboard
                <br />
                3. Message the bot: <span className="text-paper">flizy claim</span> (or{' '}
                <span className="text-paper">/claim</span> on Telegram)
                <br />
                <span className="text-xs">
                  On Telegram, share your number with /phone first so the claim can find you.
                </span>
              </p>
              <a href="/signup" className="btn btn-primary no-underline">
                Signup
              </a>
              <a href="/login" className="btn btn-ghost no-underline">
                Log in
              </a>
            </>
          ) : (
            <p className="text-muted">This claim is {data.status}.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
