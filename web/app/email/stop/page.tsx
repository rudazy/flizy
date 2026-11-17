'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * "Stop these emails" from a claim notification. One button, so opening the
 * link alone (a mail scanner, a preview) stops nothing. Payments to the
 * address still work; only these emails stop.
 */
export default function StopEmailsPage() {
  // useSearchParams needs a boundary to build.
  return (
    <Suspense fallback={null}>
      <StopEmails />
    </Suspense>
  );
}

function StopEmails() {
  const search = useSearchParams();
  const token = String(search.get('c') || '');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  async function stop() {
    setState('busy');
    try {
      const res = await fetch('/api/email/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      setState(res.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="font-sans text-3xl tracking-wide text-paper">Stop these emails</h1>
      {state === 'done' ? (
        <p className="text-paper">Done. Flizy will not email this address about payments sent to it. A payment already sent can still be claimed from its link.</p>
      ) : (
        <>
          <p className="text-muted">Stop emails telling this address that someone sent it a payment on Flizy. Payments to it still work.</p>
          <button type="button" className="btn btn-primary" disabled={state === 'busy' || !token} onClick={() => void stop()}>
            {state === 'busy' ? 'Stopping...' : 'Stop these emails'}
          </button>
          {state === 'error' ? <p className="text-gold">Could not stop them. Try again shortly.</p> : null}
        </>
      )}
    </div>
  );
}
