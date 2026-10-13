'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { clearAppearanceCache } from '../lib/appearanceCache';

/**
 * Confirm a pause. There is no delete.
 * Signing in later with the same email and the account password opens this
 * account again. The wallet and the history stay on the row.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  onDeactivate: () => Promise<string | null>;
};

export function AccountClosureSheet({ open, onClose, onDeactivate }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setBusy(false);
    setError('');
    setDone(false);
  }, [open]);

  function leave() {
    if (busy) return;
    if (done) {
      clearAppearanceCache();
      window.location.href = '/login?account=deactivated';
      return;
    }
    onClose();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') leave();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, done, onClose]);

  if (!open || typeof document === 'undefined') return null;

  async function deactivate() {
    if (busy) return;
    setBusy(true);
    setError('');
    const message = await onDeactivate();
    if (message) {
      setError(message);
      setBusy(false);
      return;
    }
    setDone(true);
    setBusy(false);
  }

  const title = done ? 'Account paused' : step === 2 ? 'Pause this account' : 'Deactivate account';

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/75 sm:items-center sm:p-6"
      role="presentation"
      onClick={() => leave()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-closure-title"
        onClick={(event) => event.stopPropagation()}
        className="relative max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-t-[20px] border border-[#3a3424] bg-[#100e0b] px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 sm:rounded-[20px]"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[#3a3a40] sm:hidden" />
        <p className="font-sans text-[11px] text-[#8d867c]">{done ? 'Finished' : `Step ${step} of 2`}</p>
        <h2 id="account-closure-title" className="mt-1 font-sans text-[16px] font-semibold text-white">
          {title}
        </h2>

        {done ? (
          <div className="mt-3">
            <p className="font-sans text-[13px] leading-relaxed text-[#d5d0c8]">
              The account is paused. Sign in with the same email and the account password and it comes back, with the wallet and the history.
            </p>
            <button
              type="button"
              className="hit-y-44 mt-4 inline-flex h-10 w-full items-center justify-center rounded-[10px] bg-[#f7d047] font-sans text-[13px] font-bold text-[#1a1405]"
              onClick={() => {
                clearAppearanceCache();
                window.location.href = '/login?account=deactivated';
              }}
            >
              Go to sign in
            </button>
          </div>
        ) : null}

        {!done && step === 1 ? (
          <div className="mt-3">
            <p className="font-sans text-[13px] leading-relaxed text-[#d5d0c8]">
              Nothing is removed. Deactivate pauses the sign-in. Come back another day with the same email and the account password, and this account opens again. You can leave now and it stays as it is.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" className="hit-y-44 h-10 rounded-[10px] border border-[#3a3a3e] font-sans text-[13px] text-[#f3f1ec]" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="hit-y-44 h-10 rounded-[10px] bg-[#f7d047] font-sans text-[13px] font-bold text-[#1a1405]"
                onClick={() => {
                  setError('');
                  setStep(2);
                }}
              >
                Continue
              </button>
            </div>
          </div>
        ) : null}

        {!done && step === 2 ? (
          <div className="mt-3">
            <p className="font-sans text-[13px] leading-relaxed text-[#d5d0c8]">
              Chat stays off while the account is paused. Sign in later with the same email and the account password to bring it back.
            </p>
            {error ? <p className="mt-3 font-sans text-[12px] text-[#f05252]">{error}</p> : null}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy}
                className="hit-y-44 h-10 rounded-[10px] border border-[#3a3a3e] font-sans text-[13px] text-[#f3f1ec] disabled:opacity-60"
                onClick={() => {
                  setError('');
                  setStep(1);
                }}
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy}
                className="hit-y-44 h-10 rounded-[10px] border border-[#f7d047] font-sans text-[13px] font-semibold text-[#f7d047] disabled:opacity-60"
                onClick={() => void deactivate()}
              >
                {busy ? 'Working' : 'Deactivate'}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
