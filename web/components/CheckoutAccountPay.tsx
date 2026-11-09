'use client';

import { useState } from 'react';

/**
 * Pay a Flizy Pay API checkout from the signed-in account's Flizy wallet
 * (/api/checkout/[id]/pay). The server decides whether the PIN is needed, from
 * what will be sent; this asks for it only when told to. The amount is what the
 * checkout still lacks, decided by the server too.
 */
export function CheckoutAccountPay({ id, amount, assetLabel, platformName }: { id: string; amount: string; assetLabel: string; platformName: string }) {
  const [pin, setPin] = useState('');
  const [needPin, setNeedPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState<{ state: string; received: string; explorerUrl: string } | null>(null);

  async function pay() {
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/checkout/${id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(needPin ? { pin } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        if (body.code === 'PIN_REQUIRED' || body.code === 'PIN_WRONG') setNeedPin(true);
        setMsg(typeof body.error === 'string' ? body.error : 'Could not pay.');
        return;
      }
      setDone({ state: String(body.state || ''), received: String(body.received || ''), explorerUrl: String(body.explorerUrl || '') });
    } catch {
      setMsg('Could not pay. Nothing was sent if your wallet shows no change.');
    } finally {
      setBusy(false);
      setPin('');
    }
  }

  if (done) {
    return (
      <div className="space-y-2">
        <div className="alert alert-ok text-sm">
          {done.state === 'confirmed' ? `Paid ${amount} ${assetLabel} to ${platformName}.` : `Received ${done.received} ${assetLabel} so far. The rest is still to pay.`}
        </div>
        {done.explorerUrl ? (
          <a href={done.explorerUrl} target="_blank" rel="noreferrer noopener" className="text-sm text-sun no-underline hover:opacity-80">
            View on explorer
          </a>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {needPin ? (
        <input
          className="input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          aria-label="PIN"
          placeholder="PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value.trim())}
          disabled={busy}
        />
      ) : null}
      <button type="button" className="btn btn-primary w-full py-3" disabled={busy || (needPin && !pin)} onClick={() => void pay()}>
        {busy ? 'Paying...' : `Pay ${amount} ${assetLabel} from my Flizy wallet`}
      </button>
      {msg ? (
        <div className="alert alert-error text-sm" role="alert">
          {msg}
        </div>
      ) : null}
    </div>
  );
}
