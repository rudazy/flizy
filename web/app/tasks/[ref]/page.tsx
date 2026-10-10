import type { Metadata } from 'next';
import { cache, type ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getAccountIdFromCookie } from '../../../lib/cookies';
import { getTaskByRef, type TaskDetail } from '../../../lib/tasks';
import { getSiteConfig } from '../../../lib/supabase';
import { TaskSubmitForm } from '../../../components/TaskSubmitForm';
import { LocalWhen } from '../../../components/LocalWhen';
import { VerifiedBadge } from '../../../components/VerifiedBadge';
import { XpChip } from '../../../components/TaskCard';
import { FeatureTaskButton, SaveTaskButton, ShareTaskButton } from '../../../components/TaskActions';
import {
  ArrowLeftIcon,
  CheckIcon,
  ClockIcon,
  ContentIcon,
  ExternalLinkIcon,
  InfoIcon,
  ListIcon,
  PeopleIcon,
  TrophyIcon,
} from '../../../components/ExploreIcons';
import { CATEGORY_LABELS, LEVEL_LABELS, LEVEL_TONES, REQUIREMENT_ACTIONS } from '../../../lib/taskLabels';

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

  const signedIn = Boolean(viewerAccountId);
  const category = task.category ? CATEGORY_LABELS[task.category] : null;
  const level = task.level ? LEVEL_LABELS[task.level] : null;
  const requirement = task.requirements[0] || null;
  const openLinks = task.links.filter((l) => /^https:\/\//i.test(l.url));

  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4">
      {/* Back, share, save, ref */}
      <nav className="flex items-center justify-between gap-3" aria-label="Task">
        <Link
          href={signedIn ? '/dashboard/explore?s=tasks' : '/'}
          className="inline-flex min-h-[44px] items-center gap-2 font-sans text-sm text-[#cfcfcf] no-underline hover:text-white"
        >
          <ArrowLeftIcon size={18} />
          {signedIn ? 'Explore' : 'Home'}
        </Link>
        <div className="flex items-center gap-2">
          <ShareTaskButton taskRef={task.ref} title={task.title} size="md" />
          <SaveTaskButton taskRef={task.ref} initialSaved={task.saved} signedIn={signedIn} size="md" />
          <span className="inline-flex h-[40px] items-center rounded-full border border-chrome-line px-4 font-mono text-sm text-[#cfcfcf]">
            #{task.ref}
          </span>
        </div>
      </nav>

      {/* Hero */}
      <header
        className="relative overflow-hidden rounded-[14px] border border-[#3a3020] p-5 sm:p-7"
        style={{
          background:
            'radial-gradient(110% 120% at 100% 0%, rgba(70, 52, 14, 0.55) 0%, rgba(20, 17, 10, 0) 60%), #100e0a',
        }}
      >
        <HeroArt />
        <div className="relative grid gap-3 sm:max-w-[72%]">
          <div className="flex flex-wrap items-center gap-2">
            {task.featured ? (
              <span className="inline-flex h-6 items-center rounded-[5px] bg-sun px-2.5 font-sans text-xs font-semibold text-sun-ink">
                Featured
              </span>
            ) : null}
            <StatusChip state={task.state} />
          </div>
          <p className="m-0 flex min-w-0 items-center gap-1.5 font-sans text-sm text-[#bdbdbd]">
            {task.creator.kind === 'project' && task.creator.handle ? (
              <Link
                href={`/project/${task.creator.handle}`}
                className="min-w-0 truncate text-[#e3e3e3] no-underline hover:text-white"
              >
                {task.creator.name}
              </Link>
            ) : (
              <span className="min-w-0 truncate">{task.creator.name}</span>
            )}
            {task.creator.verified ? <VerifiedBadge size={14} /> : null}
          </p>
          <h1 className="m-0 font-sans text-2xl font-semibold leading-tight tracking-wide text-paper sm:text-3xl">
            {task.title}
          </h1>
          {category || level ? (
            <div className="flex flex-wrap gap-2">
              {category ? (
                <span className="inline-flex h-7 items-center rounded-[6px] border border-chrome-line bg-[#141416] px-2.5 font-sans text-xs font-medium text-[#e3e3e3]">
                  {category}
                </span>
              ) : null}
              {level ? (
                <span
                  className={`inline-flex h-7 items-center rounded-[6px] border px-2.5 font-sans text-xs font-medium ${
                    LEVEL_TONES[task.level || '']
                  }`}
                >
                  {level}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      {/* At a glance */}
      <section
        className="grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-[#2e2a20] bg-[#2e2a20] sm:grid-cols-4"
        aria-label="At a glance"
      >
        <Glance icon={<TrophyIcon size={18} />} label="Reward">
          <span className="break-words text-sun">{task.rewardDisplay}</span>
          <Sub>
            {task.winnersCount} {task.winnersCount === 1 ? 'winner' : 'winners'}
          </Sub>
        </Glance>
        <Glance icon={<PeopleIcon size={18} />} label="Participants">
          {task.participants.toLocaleString('en-US')}
          <Sub>joined</Sub>
        </Glance>
        <Glance icon={<ClockIcon size={18} />} label={task.state === 'live' ? 'Time left' : 'Ended'}>
          {task.state === 'live' ? (
            <LocalWhen iso={task.endsAt} kind="remaining" />
          ) : (
            <LocalWhen iso={task.endsAt} kind="date" />
          )}
          {task.state === 'live' ? (
            <Sub>
              Ends <LocalWhen iso={task.endsAt} kind="date" />
            </Sub>
          ) : null}
        </Glance>
        <Glance icon={<ContentIcon size={18} />} label="Status">
          <StatusText state={task.state} />
        </Glance>
      </section>

      {task.description ? (
        <Panel icon={<ContentIcon size={18} />} title="About the task">
          <p className="m-0 whitespace-pre-wrap font-sans text-sm leading-relaxed text-[#cfcfcf]">{task.description}</p>
        </Panel>
      ) : null}

      {requirement || openLinks.length ? (
        <Panel icon={<ListIcon size={18} />} title="How to take part">
          <ol className="m-0 grid list-none gap-2.5 p-0">
            {openLinks.map((l, i) => (
              <li
                key={l.url}
                className="flex min-h-[48px] items-center gap-3 rounded-[10px] border border-chrome-line bg-[#111113] px-3 py-2"
              >
                <StepNumber n={i + 1} />
                <span className="min-w-0 flex-1 break-words font-sans text-sm text-[#e3e3e3]">{l.label}</span>
                <a
                  className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-[7px] border border-chrome-line bg-[#141416] px-3 font-sans text-sm text-white no-underline hover:border-[#3a3b42]"
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener nofollow"
                >
                  Open
                  <ExternalLinkIcon size={14} />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </li>
            ))}
            {requirement ? (
              <li className="flex min-h-[48px] items-center gap-3 rounded-[10px] border border-[#4a3d1c] bg-[#14110a] px-3 py-2">
                <StepNumber n={openLinks.length + 1} accent />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="break-words font-sans text-sm text-white">{requirement.label}</span>
                  <span className="font-sans text-xs text-[#a3a3a3]">
                    {REQUIREMENT_ACTIONS[requirement.kind] || 'Submit your entry'} below.
                  </span>
                </span>
                <CheckIcon size={16} className="shrink-0 text-sun" />
              </li>
            ) : null}
          </ol>
          {task.requiresXIdentity ? (
            <p className="m-0 mt-3 font-sans text-xs text-[#a3a3a3]">
              Your X account has to be linked to Flizy before you can submit.
            </p>
          ) : null}
        </Panel>
      ) : null}

      <Panel icon={<TrophyIcon size={18} />} title="Reward">
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 font-sans text-2xl font-semibold tracking-wide text-sun">{task.rewardDisplay}</p>
          {task.xpReward ? <XpChip xp={task.xpReward} /> : null}
        </div>
        <p className="m-0 mt-1 font-sans text-sm text-[#cfcfcf]">
          Shared by {task.winnersCount} {task.winnersCount === 1 ? 'winner' : 'winners'}.
        </p>
        <Distribution distribution={task.distribution} />
        {/*
          Honest about custody. Nothing is escrowed yet, so the page does not
          imply it is. A "reward secured" badge that meant nothing would be worse
          than no badge, because people would rely on it.
        */}
        <p className="m-0 mt-3 font-sans text-xs text-[#a3a3a3]">
          {task.rewardSecured
            ? 'Reward secured. The amount is held until winners are paid.'
            : 'This reward is a commitment from the creator, not yet held by Flizy.'}
        </p>
      </Panel>

      {task.state === 'completed' ? (
        <Panel icon={<TrophyIcon size={18} />} title="Winners">
          {task.winners.length === 0 ? (
            <p className="m-0 font-sans text-sm text-[#a3a3a3]">No winners were selected.</p>
          ) : (
            <ul className="m-0 grid list-none gap-2.5 p-0">
              {task.winners.map((w) => (
                <li
                  key={w.place}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-chrome-line bg-[#111113] px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="m-0 font-sans text-sm text-white">
                      {ordinal(w.place)} place
                      {w.rewardNote ? <span className="text-sun">, {w.rewardNote}</span> : null}
                    </p>
                    <p className="m-0 font-sans text-sm text-[#a3a3a3]">@{w.username}</p>
                    <p className="m-0 font-mono text-xs text-[#8a8a8a]">Submission #{w.submissionRef}</p>
                  </div>
                  {w.url ? (
                    <a
                      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-[7px] border border-chrome-line bg-[#141416] px-3 font-sans text-sm text-white no-underline hover:border-[#3a3b42]"
                      href={w.url}
                      target="_blank"
                      rel="noreferrer noopener nofollow"
                    >
                      View submission
                      <ExternalLinkIcon size={14} />
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ) : null}

      <TaskFooter task={task} viewerAccountId={viewerAccountId} />

      <Panel icon={<InfoIcon size={18} />} title="Good to know">
        <ul className="m-0 grid list-disc gap-1.5 pl-5 font-sans text-sm text-[#cfcfcf] marker:text-[#6f6f6f]">
          <li>One submission per person. It cannot be changed once sent.</li>
          <li>
            Submissions stay private while a task is open. Winning submissions are shown once winners are
            published.
          </li>
          <li>Winners hear in their chat app.</li>
        </ul>
      </Panel>

      {task.viewerIsAdmin ? <FeatureTaskButton taskRef={task.ref} initialFeatured={task.featured} /> : null}
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
    return <Notice tone="muted" title="Withdrawn" body="This task was withdrawn by its creator." />;
  }

  if (task.isCreator) {
    return (
      <Link href={`/dashboard/explore/${task.ref}/review`} className="btn btn-primary min-h-[48px] no-underline">
        {task.state === 'live' ? 'Manage this task' : 'Review submissions'}
      </Link>
    );
  }

  if (task.state === 'completed') {
    return (
      <Link href="/dashboard/explore?s=tasks" className="btn btn-ghost min-h-[48px] no-underline">
        See other tasks
      </Link>
    );
  }

  if (task.state === 'review') {
    return (
      <Notice
        tone="sun"
        title="Under review"
        body="This task has ended. The creator is reviewing submissions and will publish the winners here."
      />
    );
  }

  if (!viewerAccountId) {
    return (
      <Link
        href={`/login?next=${encodeURIComponent(`/tasks/${task.ref}`)}`}
        className="btn btn-primary min-h-[48px] no-underline"
      >
        Log in to submit
      </Link>
    );
  }

  if (task.viewerHasEntered) {
    return (
      <Notice
        tone="ok"
        title="Already submitted"
        body="You have one submission on this task. You will hear in your chat app if you win."
      />
    );
  }

  return (
    <section className="rounded-[12px] border border-[#2e2a20] bg-[#0f0f10] p-4 sm:p-5">
      <TaskSubmitForm taskRef={task.ref} requirements={task.requirements} />
    </section>
  );
}

/**
 * A clipboard of finished steps beside a coin, in line art. Drawn here rather
 * than reusing the Explore banner image, which carries blue the public pages
 * must not show. Gold and neutrals only.
 */
function HeroArt() {
  return (
    <svg
      viewBox="0 0 160 170"
      className="pointer-events-none absolute right-6 top-1/2 hidden h-[170px] w-[160px] -translate-y-1/2 select-none sm:block"
      fill="none"
      aria-hidden
    >
      <rect x="22" y="22" width="92" height="124" rx="12" fill="#14110a" stroke="#5a4a1c" strokeWidth="2" />
      <rect x="50" y="12" width="36" height="20" rx="6" fill="#1b170b" stroke="#f7d047" strokeWidth="2" />
      {[52, 80, 108].map((y, i) => (
        <g key={y}>
          <rect x="36" y={y - 9} width="18" height="18" rx="5" fill={i < 2 ? '#f7d047' : '#1b170b'} stroke="#f7d047" strokeWidth="1.6" />
          {i < 2 ? <path d={`M40 ${y} l3.5 3.5 7 -7`} stroke="#1a1405" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /> : null}
          <rect x="62" y={y - 4} width={i === 1 ? 30 : 40} height="3" rx="1.5" fill="#4a4436" />
          <rect x="62" y={y + 3} width={i === 2 ? 22 : 28} height="3" rx="1.5" fill="#2e2a20" />
        </g>
      ))}
      <circle cx="122" cy="118" r="26" fill="#1b170b" stroke="#f7d047" strokeWidth="2.4" />
      <circle cx="122" cy="118" r="19" stroke="#8c6816" strokeWidth="1.4" />
      <path d="M116 108h13M116 108v20M116 117h10" stroke="#f7d047" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-[12px] border border-chrome-card-line bg-[#0f0f10] p-4 sm:p-5">
      <h2 className="m-0 mb-3 flex items-center gap-2.5 font-sans text-base font-semibold tracking-wide text-paper">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] bg-sun-wash text-sun">
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Glance({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-1.5 bg-[#0f0f10] p-4">
      <span className="text-sun">{icon}</span>
      <span className="font-sans text-[11px] font-medium uppercase tracking-[0.12em] text-[#a3a3a3]">{label}</span>
      <span className="grid gap-0.5 font-sans text-base font-semibold text-paper">{children}</span>
    </div>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="font-sans text-xs font-normal text-[#a3a3a3]">{children}</span>;
}

function StepNumber({ n, accent = false }: { n: number; accent?: boolean }) {
  return (
    <span
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-semibold ${
        accent ? 'border-sun text-sun' : 'border-[#4a4436] text-[#e3e3e3]'
      }`}
    >
      {n}
    </span>
  );
}

const STATE_TEXT: Record<TaskDetail['state'], string> = {
  live: 'Active',
  review: 'Under review',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATE_DOT: Record<TaskDetail['state'], string> = {
  live: 'bg-[#4ade80]',
  review: 'bg-sun',
  completed: 'bg-[#4ade80]',
  cancelled: 'bg-[#6f6f6f]',
};

function StatusText({ state }: { state: TaskDetail['state'] }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-2 w-2 shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden />
      {STATE_TEXT[state]}
    </span>
  );
}

function StatusChip({ state }: { state: TaskDetail['state'] }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-[5px] border border-chrome-line bg-[#111113] px-2.5 font-sans text-xs font-medium text-[#e3e3e3]">
      <span className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[state]}`} aria-hidden />
      {STATE_TEXT[state]}
    </span>
  );
}

function Notice({ tone, title, body }: { tone: 'ok' | 'sun' | 'muted'; title: string; body: string }) {
  const box =
    tone === 'ok'
      ? 'border-[#1f5a38] bg-[#0b140e]'
      : tone === 'sun'
        ? 'border-[#4a3d1c] bg-[#14110a]'
        : 'border-chrome-line bg-[#111113]';
  const mark =
    tone === 'ok'
      ? 'border-[#2f8a55] text-[#4ade80]'
      : tone === 'sun'
        ? 'border-sun/60 text-sun'
        : 'border-chrome-line text-[#a3a3a3]';
  return (
    <section className={`flex items-center gap-4 rounded-[12px] border p-4 sm:p-5 ${box}`} role="status">
      <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border ${mark}`}>
        {tone === 'ok' ? <CheckIcon size={20} /> : tone === 'sun' ? <ClockIcon size={20} /> : <InfoIcon size={20} />}
      </span>
      <div className="min-w-0">
        <p className="m-0 font-sans text-base font-semibold text-paper">{title}</p>
        <p className="m-0 mt-0.5 font-sans text-sm text-[#cfcfcf]">{body}</p>
      </div>
    </section>
  );
}

function Distribution({ distribution }: { distribution: unknown }) {
  const rows = Array.isArray(distribution)
    ? (distribution as Array<{ place?: unknown; amount?: unknown }>)
    : [];
  const shown = rows.filter((r) => String(r.amount ?? '').trim());
  if (!shown.length) return null;
  return (
    <ul className="m-0 mt-2 grid list-none gap-1 p-0 font-mono text-xs text-muted">
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
