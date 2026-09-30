'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AppTopBar } from '../../../../../components/AppTopBar';
import { AppPage, AppSection } from '../../../../../components/AppSection';
import { LocalWhen } from '../../../../../components/LocalWhen';

/**
 * Review entries and choose winners.
 *
 * Only reachable for the creator, and the API refuses anyone else on every call
 * regardless of what this page renders. Entries are not returned at all until the
 * task has closed, and never for a cancelled task, so the winner picker is only
 * rendered for a task under review.
 *
 * Finalising is one irreversible step, so it asks first and says exactly what is
 * about to happen.
 */

type Submission = {
  id: string;
  ref: number;
  username: string;
  url: string | null;
  text: string | null;
  verification: string;
  createdAt: string;
};

export default function ReviewPage() {
  const params = useParams<{ ref: string }>();
  const router = useRouter();
  const taskRef = Number(params?.ref);

  const [state, setState] = useState<string>('');
  const [winnersCount, setWinnersCount] = useState(0);
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ winners: number; notified: number } | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch(`/api/tasks/${taskRef}/submissions`);
      const body = await res.json();
      if (res.ok) {
        setSubs((body?.submissions || []) as Submission[]);
        setWinnersCount(Number(body?.winnersCount || 0));
        setState(String(body?.state || ''));
      } else if (/closes/i.test(String(body?.error || ''))) {
        // Still live. The list is withheld on purpose, so this is a status, not a failure.
        setState('live');
        setSubs([]);
        setError('');
      } else if (/cancelled/i.test(String(body?.error || ''))) {
        // Cancelled. The entries stay private for good, and there is nobody to pick.
        setState('cancelled');
        setSubs([]);
        setError('');
      } else {
        setError(body?.error || 'Could not load submissions.');
        setSubs([]);
      }
    } catch {
      setError('Could not load submissions.');
      setSubs([]);
    }
  }, [taskRef]);

  useEffect(() => {
    if (Number.isInteger(taskRef) && taskRef > 0) load();
  }, [taskRef, load]);

  function toggle(id: string) {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((p) => p !== id);
      if (prev.length >= winnersCount) return prev;
      return [...prev, id];
    });
  }

  async function finalize() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/tasks/${taskRef}/winners`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Place comes from the order they were picked, which is the order shown
          // back to them in the confirmation.
          winners: picked.map((submissionId, i) => ({ submissionId, place: i + 1 })),
        }),
      });
      const body = await res.json();
      if (body?.ok) {
        setDone({ winners: Number(body.winners || 0), notified: Number(body.notified || 0) });
        router.refresh();
      } else {
        setError(body?.error || 'Could not publish the winners.');
      }
    } catch {
      setError('Could not publish the winners. Try again.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (done) {
    return (
      <AppPage>
        <AppTopBar title={`Task #${taskRef}`} />
        <AppSection title="Winners published">
          <div className="grid gap-2 text-sm text-muted">
            <p className="m-0">
              {done.winners} {done.winners === 1 ? 'winner' : 'winners'} published.
              {' '}
              {done.notified > 0
                ? `${done.notified} told in their chat app.`
                : 'Nobody had a chat app linked, so nobody could be messaged.'}
            </p>
            <Link href={`/tasks/${taskRef}`} className="btn btn-primary w-fit no-underline">
              See the task page
            </Link>
          </div>
        </AppSection>
      </AppPage>
    );
  }

  return (
    <AppPage>
      <AppTopBar title={`Task #${taskRef}`} />

      {error ? <p className="alert alert-error">{error}</p> : null}
      {subs === null ? <p className="text-sm text-muted">Loading...</p> : null}

      {state === 'live' ? (
        <AppSection title="Still live">
          <div className="grid gap-2 text-sm text-muted">
            <p className="m-0">
              Submissions stay private until this task ends. Come back here to
              choose winners after it closes.
            </p>
            <Link href={`/tasks/${taskRef}`} className="text-lime no-underline">
              See the task page
            </Link>
          </div>
        </AppSection>
      ) : null}

      {subs && state === 'completed' ? (
        <AppSection title="Already finished">
          <p className="m-0 text-sm text-muted">
            The winners for this task are published.{' '}
            <Link href={`/tasks/${taskRef}`} className="text-lime no-underline">
              See the task page
            </Link>
            .
          </p>
        </AppSection>
      ) : null}

      {state === 'cancelled' ? (
        <AppSection title="Cancelled">
          <p className="m-0 text-sm text-muted">
            This task was cancelled, so no winners are chosen and its submissions stay private.{' '}
            <Link href={`/tasks/${taskRef}`} className="text-lime no-underline">
              See the task page
            </Link>
            .
          </p>
        </AppSection>
      ) : null}

      {subs && state === 'review' ? (
        <>
          <AppSection
            title={`${subs.length} ${subs.length === 1 ? 'submission' : 'submissions'}`}
            helper={`Select up to ${winnersCount}. The order you select is the finishing order.`}
          >
            {subs.length === 0 ? (
              <p className="m-0 text-sm text-muted">No submissions.</p>
            ) : (
              <div className="grid gap-2">
                {subs.map((s) => {
                  const place = picked.indexOf(s.id);
                  return (
                    <div
                      key={s.id}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-2 last:border-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="m-0 font-sans text-sm tracking-wide text-paper">
                          Submission #{s.ref}
                          {s.verification === 'x_verified' ? (
                            <span className="badge badge-lime ml-2">Post verified</span>
                          ) : null}
                        </p>
                        <p className="m-0 text-sm text-muted">@{s.username}</p>
                        {s.url ? (
                          <a
                            className="m-0 text-xs text-lime no-underline hover:underline"
                            href={s.url}
                            target="_blank"
                            rel="noreferrer noopener nofollow"
                          >
                            View submission
                          </a>
                        ) : (
                          <p className="m-0 whitespace-pre-wrap text-xs text-muted">{s.text}</p>
                        )}
                        <p className="m-0 text-xs text-muted">
                          <LocalWhen iso={s.createdAt} kind="instant" />
                        </p>
                      </div>
                      <button
                        type="button"
                        className={place >= 0 ? 'btn btn-primary text-sm' : 'btn btn-ghost text-sm'}
                        onClick={() => toggle(s.id)}
                      >
                        {place >= 0 ? `Winner ${place + 1}` : 'Select winner'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </AppSection>

          {picked.length > 0 ? (
            <AppSection title={`${picked.length} selected`}>
              {confirming ? (
                <div className="grid gap-3">
                  <p className="m-0 text-sm text-paper">
                    This publishes {picked.length}{' '}
                    {picked.length === 1 ? 'winner' : 'winners'}, closes the task and
                    messages everyone who won. It cannot be undone.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn btn-primary" type="button" onClick={finalize} disabled={busy}>
                      {busy ? 'Publishing...' : 'Yes, publish'}
                    </button>
                    <button
                      className="btn btn-ghost"
                      type="button"
                      onClick={() => setConfirming(false)}
                      disabled={busy}
                    >
                      Go back
                    </button>
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  <ol className="m-0 grid list-decimal gap-1 pl-5 text-sm text-muted">
                    {picked.map((id) => {
                      const s = subs.find((x) => x.id === id);
                      return <li key={id}>{s ? `Submission #${s.ref}, @${s.username}` : id}</li>;
                    })}
                  </ol>
                  <button
                    className="btn btn-primary w-fit"
                    type="button"
                    onClick={() => setConfirming(true)}
                  >
                    Finalize winners
                  </button>
                </div>
              )}
            </AppSection>
          ) : null}
        </>
      ) : null}
    </AppPage>
  );
}


