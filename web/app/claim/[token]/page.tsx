'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

export default function ClaimPage() {
  const params = useParams();
  const token = String(params.token || '');
  const [data, setData] = useState<{ amount_eth?: string; status?: string; error?: string } | null>(
    null
  );

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
            Create a Flizy account and link WhatsApp to claim. This is the viral loop for non-users.
          </p>
          <a href="/signup" className="btn btn-primary no-underline">
            Signup to claim
          </a>
        </div>
      ) : null}
    </div>
  );
}
