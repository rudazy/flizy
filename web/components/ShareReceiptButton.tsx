'use client';

import { useState, type ReactNode } from 'react';

/**
 * Makes the receipt link for one confirmed payment and hands it to the phone's
 * share sheet, or copies it where there is none. The link is made on first
 * press only: until then the receipt does not exist outside the account.
 */
export function ShareReceiptButton({
  transferId,
  className = '',
  icon = null,
  wide = false,
}: {
  transferId: string;
  className?: string;
  /** Drawn before the label, for a button rather than a text link. */
  icon?: ReactNode;
  /** Fill the grid cell it sits in instead of hugging its label. */
  wide?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'shared' | 'error'>('idle');
  const [error, setError] = useState('');

  async function onShare() {
    if (state === 'busy') return;
    setState('busy');
    setError('');
    try {
      const res = await fetch('/api/receipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transferId }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
      if (!res.ok || typeof body.url !== 'string') {
        setError(typeof body.error === 'string' ? body.error : 'Could not make the receipt.');
        setState('error');
        return;
      }
      if (typeof navigator.share === 'function') {
        try {
          await navigator.share({ title: 'Flizy receipt', url: body.url });
          setState('shared');
          return;
        } catch {
          // Closing the share sheet is not a failure; fall through to copying.
        }
      }
      await navigator.clipboard.writeText(body.url);
      setState('copied');
    } catch {
      setError('Could not make the receipt.');
      setState('error');
    }
  }

  const label = state === 'busy' ? 'Making the receipt' : state === 'copied' ? 'Receipt link copied' : state === 'shared' ? 'Receipt shared' : 'Share receipt';
  return (
    <span className={wide ? 'grid gap-1' : 'inline-grid gap-1 justify-self-start'}>
      <button type="button" onClick={() => void onShare()} disabled={state === 'busy'} className={className || 'text-sun disabled:opacity-60'}>
        {icon}
        {label}
      </button>
      {state === 'error' ? (
        <span className="text-[#e0b070]" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
