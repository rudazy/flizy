'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Four steps before a Flizy sign-in is closed.
 *
 * Step 3 is the fork: deactivate on the left, proceed to delete on the right.
 * Only step 4 sends the account password, and only that call sets deleted_at.
 * Deactivate does not ask for the password. Signing in later is what restores it.
 */

type Props = {
  open: boolean;
  onClose: () => void;
  onDeactivate: () => Promise<string | null>;
  onDelete: (password: string) => Promise<string | null>;
};

export function AccountClosureSheet({ open, onClose, onDeactivate, onDelete }: Props) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'deactivate' | 'delete' | ''>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState<'deactivated' | 'deleted' | ''>('');

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setPassword('');
    setBusy('');
    setError('');
    setDone('');
  }, [open]);

  function leave() {
    if (busy) return;
    if (done) {
      window.location.href = done === 'deleted' ? '/login?account=deleted' : '/login?account=deactivated';
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
    setBusy('deactivate');
    setError('');
    const message = await onDeactivate();
    if (message) {
      setError(message);
      setBusy('');
      return;
    }
    setDone('deactivated');
    setBusy('');
  }

  async function remove(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy('delete');
    setError('');
    const message = await onDelete(password);
    setPassword('');
    if (message) {
      setError(message);
      setBusy('');
      return;
    }
    setDone('deleted');
    setBusy('');
  }

  const title = done
    ? done === 'deleted'
      ? 'Account deleted'
      : 'Account deactivated'
    : step === 4
      ? 'Delete this account'
      : step === 3
        ? 'Deactivate or delete'
        : step === 2
          ? 'What delete does'
          : 'Delete account';

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
        <p className="font-sans text-[11px] text-[#8d867c]">{done ? 'Finished' : `Step ${step} of 4`}</p>
        <h2 id="account-closure-title" className="mt-1 font-sans text-[16px] font-semibold text-white">
          {title}
        </h2>

        {done ? (
          <div className="mt-3">
            <p className="font-sans text-[13px] leading-relaxed text-[#d5d0c8]">
              {done === 'deleted'
                ? 'The sign-in is closed and cannot be restored. Chain records stay on the chain.'
                : 'The account is paused. Sign in with your account password and it comes back.'}
            </p>
            <button
              type="button"
              className="hit-y-44 mt-4 inline-flex h-10 w-full items-center justify-center rounded-[10px] bg-[#f7d047] font-sans text-[13px] font-bold text-[#1a1405]"
              onClick={() => {
                window.location.href = done === 'deleted' ? '/login?account=deleted' : '/login?account=deactivated';
              }}
            >
              Go to sign in
            </button>
          </div>
        ) : null}

        {!done && step === 1 ? (
          <div className="mt-3">
            <p className="font-sans text-[13px] leading-relaxed text-[#d5d0c8]">
              Nothing has been removed. Closing a Flizy sign-in takes the next three steps. You can leave now and the account stays as it is.
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
            <ul className="list-disc space-y-2 pl-4 font-sans text-[13px] leading-relaxed text-[#d5d0c8]">
              <li>Delete stops sign-in, chat, and payments to the username and pay number.</li>
              <li>A confirmed chain transaction stays on the chain. This does not send one.</li>
              <li>If the Flizy wallet still holds ETH, delete is refused. Move it first, or deactivate on the next step.</li>
            </ul>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" className="hit-y-44 h-10 rounded-[10px] border border-[#3a3a3e] font-sans text-[13px] text-[#f3f1ec]" onClick={() => setStep(1)}>
                Back
              </button>
              <button
                type="button"
                className="hit-y-44 h-10 rounded-[10px] bg-[#f7d047] font-sans text-[13px] font-bold text-[#1a1405]"
                onClick={() => {
                  setError('');
                  setStep(3);
                }}
              >
                Continue
              </button>
            </div>
          </div>
        ) : null}

        {!done && step === 3 ? (
          <div className="mt-3">
            <p className="font-sans text-[13px] leading-relaxed text-[#d5d0c8]">
              Deactivate pauses the account. Sign in later with your account password and it comes back. Proceed to delete opens the last step. That one cannot be restored.
            </p>
            {error ? <p className="mt-3 font-sans text-[12px] text-[#f05252]">{error}</p> : null}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy === 'deactivate'}
                className="hit-y-44 h-10 rounded-[10px] border border-[#f7d047] font-sans text-[13px] font-semibold text-[#f7d047] disabled:opacity-60"
                onClick={() => void deactivate()}
              >
                {busy === 'deactivate' ? 'Working' : 'Deactivate'}
              </button>
              <button
                type="button"
                disabled={busy === 'deactivate'}
                className="hit-y-44 h-10 rounded-[10px] border border-[#6b2430] bg-[#2a1216] font-sans text-[13px] font-semibold text-[#f05252] disabled:opacity-60"
                onClick={() => {
                  setError('');
                  setStep(4);
                }}
              >
                Proceed to delete
              </button>
            </div>
          </div>
        ) : null}

        {!done && step === 4 ? (
          <form className="mt-3" onSubmit={(event) => void remove(event)}>
            <p className="font-sans text-[13px] leading-relaxed text-[#d5d0c8]">
              Last step. This deletes the sign-in. It cannot be restored with your account password. Chain records stay. There is no passkey on the account, so the password you sign in with is the proof.
            </p>
            <label className="mt-3 block font-sans text-[12px] text-[#c8c2b8]" htmlFor="flizy-delete-password">
              Account password
            </label>
            <input
              id="flizy-delete-password"
              className="input mt-1"
              type="password"
              autoComplete="current-password"
              value={password}
              maxLength={200}
              onChange={(event) => setPassword(event.target.value.slice(0, 200))}
              required
            />
            {error ? <p className="mt-3 font-sans text-[12px] text-[#f05252]">{error}</p> : null}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={busy === 'delete'}
                className="hit-y-44 h-10 rounded-[10px] border border-[#3a3a3e] font-sans text-[13px] text-[#f3f1ec] disabled:opacity-60"
                onClick={() => {
                  setPassword('');
                  setError('');
                  setStep(3);
                }}
              >
                Back
              </button>
              <button
                type="submit"
                disabled={busy === 'delete'}
                className="hit-y-44 h-10 rounded-[10px] bg-[#6b2430] font-sans text-[13px] font-semibold text-[#f05252] disabled:opacity-60"
              >
                {busy === 'delete' ? 'Working' : 'Delete account'}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>,
    document.body
  );
}
