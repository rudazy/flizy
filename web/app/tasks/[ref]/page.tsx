import type { Metadata } from 'next';
import { cache } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getTaskByRef, type TaskDetail } from '../../../lib/tasks';
import { getSiteConfig } from '../../../lib/supabase';
import { TaskCardArt } from '../../../components/TaskCardArt';
import { TaskSubmitForm } from '../../../components/TaskSubmitForm';
import { LocalWhen } from '../../../components/LocalWhen';
import { VerifiedBadge } from '../../../components/VerifiedBadge';
import { XpChip } from '../../../components/TaskCard';

/**
 * The public task page.
 *
 * A server component for the reason /pay/[code] is one: this page is meant to be
 * shared, so it has to render for somebody with no session and be worth something
 * to a link preview.
 *
 * Entries are never rendered while a task is live or under review. Once it is
 * completed the winning entries are shown in full, which is the useful part of
 * the record: what actually won, not just who.
 */

export const dynamic = 'force-dynamic';

function refFrom(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * One read per request, shared by the metadata and the page.
 *
 * Next calls generateMetadata and the component separately, and each was doing
 * the full load: six queries apiece, twelve per view, on the page most likely
 * to be opened by a crowd at once because it is the one people share. React's
 * cache dedupes within a single request, so the second caller gets the first
 * one's result.
 *
 * Keyed on the viewer too, because the load personalises: dropping that from
 * the key would let one visitor's "you have already entered" be served to the
 * next. Both callers read the viewer through viewerId, so they pass the same
 * key and share the one load. The metadata uses only public fields.
 */
const loadTask = cache((ref: number, viewerAccountId: string | null) =>
  getTaskByRef(ref, { viewerAccountId })
);

// A signed-out reader is the normal case, so a missing cookie is not an error.
const viewerId = cache(() => getAccountIdFromCookie().catch(() => null));

export async function generateMetadata({ params }: { params: { ref: string } }): Promise<Metadata> {
  const ref = refFrom(params.ref);
  if (ref === null) return { title: 'Task not found' };

  const task = await loadTask(ref, await viewerId()).catch(() => null);
  if (!task) return { title: 'Task not found' };

  const title = `${task.title} - Flizy task #${task.ref}`;
  const description = `${task.rewardDisplay} for ${task.winnersCount} ${
    task.winnersCount === 1 ? 'winner' : 'winners'
  }. ${task.participants} ${task.participants === 1 ? 'entry' : 'entries'} so far.`;
  const url = `${String(getSiteConfig().siteUrl || '').replace(/\/+$/, '')}/tasks/${task.ref}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: 'article' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function TaskPage({ params }: { params: { ref: string } }) {
  const ref = refFrom(params.ref);
  if (ref === null) notFound();

  const viewerAccountId = await viewerId();
  const task = await loadTask(ref, viewerAccountId);
  if (!task) notFound();

  return (
    <div className="mx-auto grid w-full max-w-lg gap-8">
      <header className="grid gap-3">
        <Link
          href={viewerAccountId ? '/dashboard/explore' : '/'}
          className="text-xs uppercase tracking-[0.18em] text-muted no-underline hover:text-paper"
        >
          {viewerAccountId ? 'Explore' : 'Home'}
        </Link>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="m-0 flex items-center gap-1.5 font-sans text-sm tracking-wide text-paper">
              <span className="min-w-0 truncate">{task.creator.name}</span>
              {task.creator.verified ? <VerifiedBadge size={13} /> : null}
            </p>
            {task.creator.kind === 'project' && task.creator.handle ? (
              <p className="m-0 font-mono text-xs text-muted">project/{task.creator.handle}</p>
            ) : null}
          </div>
          <span className="font-mono text-xs text-muted">#{task.ref}</span>
        </div>
        <h1 className="m-0 font-sans text-2xl tracking-wide text-paper sm:text-3xl">{task.title}</h1>
        <StateLine state={task.state} />
      </header>

      <TaskCardArt taskRef={task.ref} label={task.title} className="rounded-md" />

      <section className="grid gap-2">
        <h2 className="m-0 text-xs uppercase tracking-[0.18em] text-gold">Reward</h2>
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 font-sans text-4xl font-semibold tracking-wide text-lime">{task.rewardDisplay}</p>
          {task.xpReward ? <XpChip xp={task.xpReward} /> : null}
        </div>
        <p className="m-0 text-sm text-paper">
          {task.winnersCount} {task.winnersCount === 1 ? 'winner' : 'winners'}
        </p>
        <Distribution distribution={task.distribution} />
        {/*
          Honest about custody. Nothing is escrowed yet, so the page does not
          imply it is. A "reward secured" badge that meant nothing would be worse
          than no badge, because people would rely on it.
        */}
        <p className="m-0 pt-1 text-xs text-muted">
          {task.rewardSecured
            ? 'Reward secured. The amount is held until winners are paid.'
            : 'This reward is a commitment from the creator, not yet held by Flizy.'}
        </p>
      </section>

      <section className="grid gap-1 border-y border-border py-4">
        <p className="m-0 font-sans text-lg tracking-wide text-paper">
          {task.participants} {task.participants === 1 ? 'participant' : 'participants'}
        </p>
        <p className="m-0 text-sm text-muted">
          {task.state === 'live' ? 'Ends' : 'Ended'} <LocalWhen iso={task.endsAt} kind="date" />
        </p>
        <p className="m-0 text-sm text-muted">
          <LocalWhen iso={task.endsAt} kind="remaining" />
        </p>
        <p className="m-0 pt-1 text-xs text-muted">
          Submissions stay private while a task is open. Winning submissions are
          shown once winners are published.
        </p>
      </section>

      {task.description ? (
        <section className="grid gap-2">
          <h2 className="m-0 text-xs uppercase tracking-[0.18em] text-gold">About the task</h2>
          <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-muted">{task.description}</p>
        </section>
      ) : null}

      {task.requirements.length ? (
        <section className="grid gap-2">
          <h2 className="m-0 text-xs uppercase tracking-[0.18em] text-gold">Requirements</h2>
          <ul className="m-0 grid list-none gap-2 p-0 text-sm text-paper">
            {task.requirements.map((r) => (
              <li key={r.id} className="flex gap-2">
                <Check />
                <span>{r.label}</span>
              </li>
            ))}
          </ul>
          {task.requiresXIdentity ? (
            <p className="m-0 text-xs text-muted">
              Your X account has to be linked to Flizy before you can submit.
            </p>
          ) : null}
        </section>
      ) : null}

      {task.links.length ? (
        <section className="grid gap-2">
          <h2 className="m-0 text-xs uppercase tracking-[0.18em] text-gold">References</h2>
          <ul className="m-0 grid list-none gap-2 p-0 text-sm">
            {task.links.map((l) => (
              <li key={l.url}>
                <a
                  className="text-lime no-underline hover:underline"
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener nofollow"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {task.state === 'completed' ? (
        <section className="grid gap-3">
          <h2 className="m-0 text-xs uppercase tracking-[0.18em] text-gold">Winners</h2>
          {task.winners.length === 0 ? (
            <p className="m-0 text-sm text-muted">No winners were selected.</p>
          ) : (
            task.winners.map((w) => (
              <div key={w.place} className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3 last:border-0">
                <div className="min-w-0">
                  <p className="m-0 font-sans text-sm tracking-wide text-paper">
                    Winner {w.place}
                    {w.rewardNote ? `, ${w.rewardNote}` : ''}
                  </p>
                  <p className="m-0 text-sm text-muted">@{w.username}</p>
                  <p className="m-0 font-mono text-xs text-muted">Submission #{w.submissionRef}</p>
                </div>
                {w.url ? (
                  <a
                    className="btn btn-ghost text-sm no-underline"
                    href={w.url}
                    target="_blank"
                    rel="noreferrer noopener nofollow"
                  >
                    View submission
                  </a>
                ) : null}
              </div>
            ))
          )}
        </section>
      ) : null}

      <TaskFooter task={task} viewerAccountId={viewerAccountId} />
    </div>
  );
}

function TaskFooter({
  task,
  viewerAccountId,
}: {
  task: TaskDetail;
  viewerAccountId: string | null;
}) {
  if (task.state === 'cancelled') {
    return <p className="alert alert-warn">This task was withdrawn by its creator.</p>;
  }

  if (task.isCreator) {
    return (
      <Link href={`/dashboard/explore/${task.ref}/review`} className="btn btn-primary no-underline">
        {task.state === 'live' ? 'Manage this task' : 'Review submissions'}
      </Link>
    );
  }

  if (task.state === 'completed') {
    return (
      <Link href="/dashboard/explore" className="btn btn-ghost no-underline">
        See other tasks
      </Link>
    );
  }

  if (task.state === 'review') {
    return (
      <p className="alert">
        Task ended. Submissions are being reviewed by the creator. Status: under review.
      </p>
    );
  }

  if (!viewerAccountId) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent(`/tasks/${task.ref}`)}`}
        className="btn btn-primary no-underline"
      >
        Log in to submit
      </Link>
    );
  }

  if (task.viewerHasEntered) {
    return (
      <p className="alert alert-ok">
        Already submitted. You have one submission on this task. You will hear in
        your chat app if you win.
      </p>
    );
  }

  return <TaskSubmitForm taskRef={task.ref} requirements={task.requirements} />;
}

function StateLine({ state }: { state: TaskDetail['state'] }) {
  if (state === 'live') return null;
  const label =
    state === 'review' ? 'Under review' : state === 'completed' ? 'Completed' : 'Cancelled';
  return <p className="m-0 text-xs uppercase tracking-[0.18em] text-gold">{label}</p>;
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="mt-0.5 h-4 w-4 shrink-0 text-lime" aria-hidden>
      <path d="M3 8.5 6.2 12 13 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function Distribution({ distribution }: { distribution: unknown }) {
  const rows = Array.isArray(distribution)
    ? (distribution as Array<{ place?: unknown; amount?: unknown }>)
    : [];
  const shown = rows.filter((r) => String(r.amount ?? '').trim());
  if (!shown.length) return null;
  return (
    <ul className="m-0 grid list-none gap-1 p-0 font-mono text-xs text-muted">
      {shown.map((r, i) => {
        const place = Number(r.place ?? i + 1);
        return (
          <li key={i}>
            {ordinal(place)}: {String(r.amount)}
          </li>
        );
      })}
    </ul>
  );
}

function ordinal(n: number): string {
  const place = Number.isInteger(n) && n > 0 ? n : 0;
  const mod100 = place % 100;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? 'th'
      : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[place % 10] || 'th';
  return `${place}${suffix}`;
}
