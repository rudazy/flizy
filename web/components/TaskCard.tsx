'use client';

import Link from 'next/link';
import { formatCardEnds } from '../lib/taskTime';
import { TaskCardArt } from './TaskCardArt';
import { VerifiedBadge } from './VerifiedBadge';

/**
 * One task on the discovery list.
 *
 * Kept to what somebody needs in order to decide whether to open it: what the
 * job is, what it pays, how many can win, how many are in, and how long is left.
 * No description and no entries. Entries in particular are withheld everywhere
 * until a task completes, so nobody can copy an idea that has not won yet.
 */

export type TaskCardData = {
  ref: number;
  title: string;
  rewardDisplay: string;
  winnersCount: number;
  participants: number;
  endsAt: string;
  state: 'live' | 'review' | 'completed' | 'cancelled';
  /** XP each winner earns, when the project set some. */
  xpReward?: number | null;
  creator: { kind: 'project' | 'personal'; name: string; handle: string | null; verified?: boolean };
};

/**
 * `preview` is the Create task page's live preview: the same card, not a link,
 * since the task does not exist until it is published.
 */
export function TaskCard({ task, preview = false }: { task: TaskCardData; preview?: boolean }) {
  const body = (
    <>
      <TaskCardArt taskRef={task.ref} label={task.title} />
      <div className="grid gap-1.5 p-4">
        <h3 className="m-0 font-sans text-base tracking-wide text-paper">{task.title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <p className="m-0 font-sans text-xl font-semibold text-lime">{task.rewardDisplay}</p>
          {task.xpReward ? <XpChip xp={task.xpReward} /> : null}
        </div>
        <p className="m-0 text-sm text-paper">
          {task.winnersCount} {task.winnersCount === 1 ? 'Winner' : 'Winners'}
        </p>
        <p className="m-0 text-sm text-muted">{task.participants} participating</p>
        <p className="m-0 text-sm text-muted">{formatCardEnds(task.endsAt, task.state, Date.now())}</p>
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate font-sans text-sm tracking-wide text-paper">{task.creator.name}</span>
            {task.creator.verified ? <VerifiedBadge size={13} /> : null}
          </span>
          <span className="font-mono text-xs text-muted">{preview ? 'Preview' : `#${task.ref}`}</span>
        </div>
      </div>
    </>
  );

  if (preview) {
    return <div className="card overflow-hidden p-0">{body}</div>;
  }

  return (
    <Link href={`/tasks/${task.ref}`} className="card card-hover block overflow-hidden p-0 no-underline">
      {body}
    </Link>
  );
}

/** The XP a winner earns on top of the reward. */
export function XpChip({ xp }: { xp: number }) {
  return (
    <span className="inline-flex items-center rounded-[4px] border border-sun/40 bg-sun-wash px-1.5 py-0.5 font-mono text-[11px] font-semibold text-sun">
      +{xp.toLocaleString('en-US')} XP
    </span>
  );
}
