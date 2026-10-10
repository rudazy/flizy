'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Entering a task.
 *
 * The form asks for exactly what the task's requirement needs. A task has one,
 * and submitToTask checks an entry against that same first row. Everything
 * that decides whether an entry is allowed lives on the server and in the
 * database, so this is shape and wording only: a friendly refusal here and the
 * real one underneath.
 */
export function TaskSubmitForm({
  taskRef,
  requirements,
}: {
  taskRef: number;
  requirements: Array<{ id: string; kind: string; label: string }>;
}) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ ref: number; verified: boolean } | null>(null);

  const kind = requirements[0]?.kind || 'text';
  const wantsUrl = kind === 'x_post' || kind === 'link';

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/tasks/${taskRef}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(wantsUrl ? { url: value.trim() } : { text: value.trim() }),
      });
      const body = await res.json();
      if (body?.ok) {
        setDone({ ref: body.submissionRef, verified: body.verification === 'x_verified' });
        // The page shows entry state, so it has to be re-read rather than patched.
        router.refresh();
      } else {
        setError(body?.error || 'Could not submit that.');
      }
    } catch {
      setError('Could not submit that. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p className="alert alert-ok">
        Submission #{done.ref}.
        {done.verified ? ' Post verified. Your X account matches the link.' : ''} You
        will hear in your chat app if you win.
      </p>
    );
  }

  const heading = kind === 'x_post' ? 'Submit your X post' : 'Submit your entry';

  if (confirming) {
    return (
      <form onSubmit={onSubmit} className="grid gap-3">
        <h2 className="m-0 font-sans text-base font-semibold tracking-wide text-paper">Confirm submission</h2>
        <p className="m-0 whitespace-pre-wrap break-all font-mono text-sm text-paper">{value.trim()}</p>
        <p className="m-0 text-xs text-muted">
          One submission per person. You cannot change it after this.
        </p>
        {error ? <p className="alert alert-error m-0">{error}</p> : null}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Submitting...' : 'Confirm submission'}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setError('');
          }}
        >
          Back
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setError('');
        setConfirming(true);
      }}
      className="grid gap-3"
    >
      <h2 className="m-0 font-sans text-base font-semibold tracking-wide text-paper">{heading}</h2>
      <div>
        <label className="mb-2 block font-sans text-sm text-[#cfcfcf]" htmlFor="task-entry">
          {requirements[0]?.label || 'Your submission'}
        </label>
        {wantsUrl ? (
          <input
            id="task-entry"
            className="input font-mono"
            type="url"
            inputMode="url"
            placeholder={kind === 'x_post' ? 'https://x.com/you/status/...' : 'https://...'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
        ) : (
          <textarea
            id="task-entry"
            className="input"
            rows={4}
            placeholder="Write your submission"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
        )}
      </div>

      {error ? <p className="alert alert-error m-0">{error}</p> : null}

      <button className="btn btn-primary" type="submit" disabled={!value.trim()}>
        Continue
      </button>
    </form>
  );
}
