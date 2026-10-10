'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatCardEnds } from '../lib/taskTime';
import { CATEGORY_LABELS, LEVEL_LABELS, LEVEL_TONES } from '../lib/taskLabels';
import { LocalWhen } from './LocalWhen';
import { VerifiedBadge } from './VerifiedBadge';
import { SaveTaskButton, ShareTaskButton } from './TaskActions';
import {
  ArrowRightIcon,
  ChevronRightIcon,
  ClockIcon,
  ContentIcon,
  ExternalLinkIcon,
  OnchainIcon,
  PeopleIcon,
  SocialIcon,
  TrophyIcon,
} from './ExploreIcons';

/**
 * One task on the discovery list.
 *
 * Enough to decide whether to take part without opening the page: who set it,
 * what it pays, how many can win, how many are in, how long is left, and the
 * steps. Entries are never shown here. They are withheld everywhere until a task
 * completes, so nobody can copy an idea that has not won yet.
 */

export type TaskCardStep =
  | { kind: 'open'; label: string; url: string }
  | { kind: 'submit'; label: string; requirement: string };

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
  description?: string;
  category?: string | null;
  level?: string | null;
  featured?: boolean;
  steps?: TaskCardStep[];
  saved?: boolean;
  /** My tasks only: how the task is the viewer's. */
  relations?: Array<'saved' | 'joined' | 'created'>;
};

/** Steps shown on the card. The task page lists every one. */
const CARD_STEPS = 3;

const CATEGORY_ICONS: Record<string, ReactNode> = {
  social: <SocialIcon size={10} />,
  onchain: <OnchainIcon size={10} />,
  community: <PeopleIcon size={10} />,
  content: <ContentIcon size={10} />,
};

const RELATION_LABELS: Record<string, string> = { saved: 'Saved', joined: 'Joined', created: 'Created by you' };

/**
 * `preview` is the Create task page's live preview: the same card with nothing
 * to press, since the task does not exist until it is published.
 */
export function TaskCard({ task, preview = false }: { task: TaskCardData; preview?: boolean }) {
  const href = `/tasks/${task.ref}`;
  const live = task.state === 'live';
  const steps = task.steps || [];
  const shownSteps = steps.slice(0, CARD_STEPS);
  const moreSteps = steps.length - shownSteps.length;
  const category = task.category ? CATEGORY_LABELS[task.category] : null;
  const level = task.level ? LEVEL_LABELS[task.level] : null;
  const ends = formatCardEnds(task.endsAt, task.state, Date.now());

  return (
    <article
      className={`relative overflow-hidden rounded-[10px] border p-[11px] ${
        task.featured ? 'border-[#4a3d1c] bg-[#12100b]' : 'border-chrome-card-line bg-[#0f0f10]'
      }`}
      aria-label={task.title}
    >
      {/* Badges and actions */}
      <div className="flex min-h-[26px] items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-[5px]">
          {task.featured ? (
            <span className="inline-flex h-[17px] items-center rounded-[4px] bg-sun px-[7px] font-sans text-[8.5px] font-semibold text-sun-ink">
              Featured
            </span>
          ) : null}
          {!live ? <StatePill state={task.state} /> : null}
          {(task.relations || []).map((r) => (
            <span
              key={r}
              className="inline-flex h-[17px] items-center rounded-[4px] border border-chrome-line px-[6px] font-sans text-[8px] font-medium text-[#cfcfcf]"
            >
              {RELATION_LABELS[r]}
            </span>
          ))}
          {preview ? (
            <span className="inline-flex h-[17px] items-center rounded-[4px] border border-chrome-line px-[6px] font-sans text-[8px] font-medium text-[#9d9d9d]">
              Preview
            </span>
          ) : null}
        </div>
        {preview ? null : (
          <div className="flex items-center gap-[6px]">
            <ShareTaskButton taskRef={task.ref} title={task.title} />
            <SaveTaskButton taskRef={task.ref} initialSaved={Boolean(task.saved)} />
          </div>
        )}
      </div>

      {/* Identity and reward */}
      <div className="mt-[8px] grid grid-cols-[minmax(0,1fr)_auto] gap-[10px]">
        <div className="flex min-w-0 gap-[9px]">
          <Monogram name={task.creator.name} featured={Boolean(task.featured)} />
          <div className="grid min-w-0 content-start gap-[4px]">
            <h3 className="m-0 font-sans text-[12.5px] font-semibold leading-[15px] tracking-[0.01em] text-white">
              {preview ? task.title : (
                <Link href={href} className="text-white no-underline hover:text-sun">
                  {task.title}
                </Link>
              )}
            </h3>
            <p className="m-0 flex min-w-0 items-center gap-[4px] font-sans text-[9.5px] text-[#a3a3a3]">
              <span className="min-w-0 truncate">By {task.creator.name}</span>
              {task.creator.verified ? <VerifiedBadge size={11} /> : null}
            </p>
            {category || level ? (
              <div className="flex flex-wrap gap-[5px]">
                {category ? (
                  <span className="inline-flex h-[17px] items-center gap-[4px] rounded-[4px] border border-chrome-line bg-[#141416] px-[6px] font-sans text-[8.5px] font-medium text-[#d9d9d9]">
                    <span className="text-sun">{CATEGORY_ICONS[task.category || '']}</span>
                    {category}
                  </span>
                ) : null}
                {level ? (
                  <span
                    className={`inline-flex h-[17px] items-center rounded-[4px] border px-[6px] font-sans text-[8.5px] font-medium ${
                      LEVEL_TONES[task.level || '']
                    }`}
                  >
                    {level}
                  </span>
                ) : null}
              </div>
            ) : null}
            {task.description ? (
              <p className="m-0 line-clamp-2 font-sans text-[9.5px] leading-[13px] text-[#bdbdbd]">{task.description}</p>
            ) : null}
          </div>
        </div>

        <div className="grid w-[108px] content-start gap-[7px] rounded-[8px] border border-chrome-line bg-[#141416] p-[8px]">
          <div className="grid gap-[2px]">
            <span className="font-sans text-[7.5px] font-medium uppercase tracking-[0.08em] text-[#9d9d9d]">Reward</span>
            <span className="break-words font-sans text-[13.5px] font-bold leading-[16px] text-sun">{task.rewardDisplay}</span>
            {task.xpReward ? <XpChip xp={task.xpReward} compact /> : null}
          </div>
          {preview ? (
            <span className="btn-sun pointer-events-none h-[26px] gap-[5px] rounded-[5px] font-sans text-[9px]" aria-hidden>
              Start task
              <ArrowRightIcon size={10} strokeWidth={2.4} />
            </span>
          ) : (
            <Link
              href={href}
              className="btn-sun hit-y-44 relative h-[26px] gap-[5px] rounded-[5px] font-sans text-[9px] no-underline"
            >
              {live ? 'Start task' : task.state === 'completed' ? 'See winners' : 'View task'}
              <ArrowRightIcon size={10} strokeWidth={2.4} />
            </Link>
          )}
        </div>
      </div>

      {/* Stats */}
      <dl className="m-0 mt-[10px] grid grid-cols-3 border-y border-chrome-card-line py-[8px]">
        <Stat icon={<PeopleIcon size={12} />} label="Participants">
          {task.participants.toLocaleString('en-US')} joined
        </Stat>
        <Stat icon={<TrophyIcon size={12} />} label="Winners" divided>
          {task.winnersCount} {task.winnersCount === 1 ? 'winner' : 'winners'}
        </Stat>
        <Stat icon={<ClockIcon size={12} />} label="Time" divided>
          {live ? (
            ends
          ) : (
            // The state is already on the pill above, so the stat says when it ended.
            <>
              Ended <LocalWhen iso={task.endsAt} kind="date" />
            </>
          )}
        </Stat>
      </dl>

      {/* Steps */}
      {shownSteps.length ? (
        <section className="mt-[10px]" aria-label="Task steps">
          <h4 className="m-0 font-sans text-[10px] font-semibold text-white">Task steps</h4>
          <ol className="relative m-0 mt-[7px] grid list-none gap-[6px] p-0">
            {shownSteps.map((step, i) => (
              <li key={`${step.kind}-${i}`} className="relative flex min-h-[26px] items-center gap-[8px]">
                {i < shownSteps.length - 1 ? (
                  <span className="absolute left-[8px] top-[21px] h-[calc(100%-10px)] w-px bg-[#2c2a24]" aria-hidden />
                ) : null}
                <span
                  className={`relative flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border font-mono text-[8.5px] font-semibold ${
                    i === 0 ? 'border-sun text-sun' : 'border-[#4a4436] text-[#d9d9d9]'
                  }`}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-sans text-[10px] text-[#e3e3e3]">{step.label}</span>
                {step.kind === 'open' ? (
                  preview ? (
                    <StepTag>Open</StepTag>
                  ) : (
                    <a
                      href={step.url}
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                      className="hit-y-44 relative inline-flex h-[22px] shrink-0 items-center gap-[4px] rounded-[5px] border border-chrome-line bg-[#141416] px-[8px] font-sans text-[8.5px] font-medium text-white no-underline hover:border-[#3a3b42]"
                    >
                      Open
                      <ExternalLinkIcon size={9} />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  )
                ) : preview || !live ? (
                  <StepTag tone="sun">Submit</StepTag>
                ) : (
                  // The entry form lives on the task page.
                  <Link
                    href={href}
                    className="hit-y-44 relative inline-flex h-[22px] shrink-0 items-center rounded-[5px] border border-[#5a4a1c] bg-sun-wash px-[8px] font-sans text-[8.5px] font-medium text-sun no-underline hover:border-sun/70"
                  >
                    Submit
                  </Link>
                )}
              </li>
            ))}
          </ol>
          {moreSteps > 0 ? (
            <p className="m-0 mt-[5px] pl-[25px] font-sans text-[9px] text-[#9d9d9d]">
              +{moreSteps} more {moreSteps === 1 ? 'step' : 'steps'} on the task page
            </p>
          ) : null}
        </section>
      ) : null}

      {preview ? null : (
        <Link
          href={href}
          className="hit-y-44 relative mt-[10px] flex h-[30px] items-center justify-center gap-[5px] rounded-[6px] border border-chrome-line bg-[#131315] font-sans text-[9.5px] font-medium text-[#d9d9d9] no-underline hover:border-[#3a3b42] hover:text-white"
        >
          View details
          <ChevronRightIcon size={11} />
        </Link>
      )}

      <p className="m-0 mt-[8px] text-right font-mono text-[8px] text-[#6f6f6f]">{preview ? 'Preview' : `#${task.ref}`}</p>
    </article>
  );
}

/** The XP a winner earns on top of the reward. */
export function XpChip({ xp, compact = false }: { xp: number; compact?: boolean }) {
  return (
    <span
      className={`inline-flex w-fit items-center rounded-[4px] border border-sun/40 bg-sun-wash font-mono font-semibold text-sun ${
        compact ? 'px-[5px] py-px text-[8.5px]' : 'px-1.5 py-0.5 text-[11px]'
      }`}
    >
      +{xp.toLocaleString('en-US')} XP
    </span>
  );
}

/** The creator's initials on a tile. There are no uploaded task images. */
function Monogram({ name, featured }: { name: string; featured: boolean }) {
  const letters = initialsOf(name);
  return (
    <span
      className={`flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[9px] border font-sans text-[17px] font-bold ${
        featured ? 'border-[#5a4a1c] bg-[#0b0a07] text-sun' : 'border-chrome-line bg-[#0b0b0c] text-sun'
      }`}
      aria-hidden
    >
      {letters}
    </span>
  );
}

function initialsOf(name: string): string {
  const words = String(name || '')
    .replace(/^@/, '')
    .trim()
    .split(/[\s_.-]+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (!words.length) return 'F';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function Stat({
  icon,
  label,
  divided = false,
  children,
}: {
  icon: ReactNode;
  label: string;
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-[5px] px-[6px] first:pl-0 ${divided ? 'border-l border-chrome-card-line' : ''}`}>
      <span className="shrink-0 text-sun">{icon}</span>
      <dt className="sr-only">{label}</dt>
      <dd className="m-0 min-w-0 truncate font-sans text-[9px] text-[#cfcfcf]">{children}</dd>
    </div>
  );
}

function StatePill({ state }: { state: TaskCardData['state'] }) {
  const label = state === 'review' ? 'Under review' : state === 'completed' ? 'Completed' : 'Cancelled';
  const tone =
    state === 'completed'
      ? 'border-[#1f5a38] text-[#4ade80]'
      : state === 'review'
        ? 'border-[#5a4a1c] text-sun'
        : 'border-chrome-line text-[#9d9d9d]';
  return (
    <span className={`inline-flex h-[17px] items-center rounded-[4px] border px-[6px] font-sans text-[8px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

function StepTag({ children, tone = 'plain' }: { children: ReactNode; tone?: 'plain' | 'sun' }) {
  return (
    <span
      className={`inline-flex h-[22px] shrink-0 items-center rounded-[5px] border px-[8px] font-sans text-[8.5px] font-medium ${
        tone === 'sun' ? 'border-[#5a4a1c] bg-sun-wash text-sun' : 'border-chrome-line bg-[#141416] text-white'
      }`}
    >
      {children}
    </span>
  );
}
