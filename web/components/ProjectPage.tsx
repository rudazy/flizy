'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type {
  ProjectActivity,
  ProjectLeaderboard,
  ProjectLink,
  ProjectRole,
  ProjectStats,
  RecentReward,
  TaskListItem,
} from '../lib/tasks';
import { ProjectAvatar } from './ProjectAvatar';
import { VerifiedBadge } from './VerifiedBadge';
import { Leaderboard } from './ProjectLeaderboard';
import { LocalWhen } from './LocalWhen';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BoltIcon,
  BookOpenIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  CrownIcon,
  EthDiamondIcon,
  ExternalLinkIcon,
  GiftIcon,
  GithubIcon,
  GlobeIcon,
  InfoIcon,
  ListIcon,
  MoreVerticalIcon,
  PaperPlaneIcon,
  PencilIcon,
  PeopleIcon,
  PlusIcon,
  ShareIcon,
  SocialIcon,
  StarIcon,
  SwapArrowsIcon,
  TasksIcon,
  TrophyIcon,
  XLogoIcon,
} from './ExploreIcons';

/**
 * A project's page. One component for the in-app workspace and the public page
 * at /project/<handle>, so the two never drift apart; `mode` and the reader's
 * role decide which controls show. It only draws what it is given: every
 * figure comes from the server (lib/tasks.ts), nothing here is estimated.
 */

export type ProjectPageData = {
  /** Present for the owner and members, who need it to publish a task for the project. */
  id?: string;
  handle: string;
  name: string;
  description: string;
  verified: boolean;
  image: string | null;
  banner: string | null;
  createdAt: string | null;
  links: ProjectLink[];
  role: ProjectRole | null;
  stats: ProjectStats;
  tasks: TaskListItem[];
  leaderboard: ProjectLeaderboard;
  recentRewards: RecentReward[];
  activity: ProjectActivity[];
  liveCap: number;
};

type Tab = 'tasks' | 'rewards' | 'leaderboard' | 'about';
type Filter = 'all' | 'live' | 'ended' | 'social' | 'onchain' | 'community' | 'content';

const CARD = 'rounded-[14px] border border-[#232323] bg-[#101010]';
const GHOST_BUTTON =
  'hit-y-44 inline-flex h-10 items-center justify-center gap-2 rounded-[8px] border border-[#383838] px-3.5 font-sans text-sm text-[#f5f5f5] no-underline transition-colors hover:border-[#5a5a5a]';
const PRIMARY_SMALL =
  'hit-y-44 inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[8px] bg-sun px-4 font-sans text-sm font-semibold text-sun-ink no-underline transition-opacity hover:opacity-90';

/** Warm light from the top left of the hero, under the logo. */
const HERO_GLOW =
  'radial-gradient(70% 120% at 0% 0%, rgba(70, 50, 16, 0.6) 0%, rgba(40, 30, 12, 0.25) 45%, rgba(11, 11, 11, 0) 80%), #0b0b0b';

const CATEGORY_LABEL: Record<string, string> = {
  social: 'Social',
  onchain: 'Onchain',
  community: 'Community',
  content: 'Content',
};
const LEVEL_LABEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

/** Chip tones in the gold, copper and grey palette. No blue anywhere. */
const CATEGORY_TONE: Record<string, string> = {
  social: 'border-sun/45 text-sun',
  onchain: 'border-[#a86b3c]/70 text-[#d89a64]',
  community: 'border-[#c4893f]/60 text-[#e0a85a]',
  content: 'border-[#7a7a7a] text-[#d0d0d0]',
};
const LEVEL_TONE = 'border-[#3a3a3a] text-[#a9a9a9]';

const TILE_TONE: Record<string, string> = {
  social: 'bg-sun-wash text-sun border-sun/30',
  onchain: 'bg-[#1d140c] text-[#d89a64] border-[#a86b3c]/40',
  community: 'bg-[#1d160c] text-[#e0a85a] border-[#c4893f]/40',
  content: 'bg-[#171717] text-[#d0d0d0] border-[#3a3a3a]',
};

/** Gold, silver and bronze for the first three places. */
const PLACE_BADGE = ['bg-sun text-sun-ink', 'bg-[#cfcfcf] text-[#141414]', 'bg-[#b8834f] text-[#141414]'];

const ROWS_BEFORE_ALL = 4;

function categoryIcon(category: string | null, size = 22) {
  if (category === 'social') return <SocialIcon size={size} />;
  if (category === 'onchain') return <SwapArrowsIcon size={size} />;
  if (category === 'community') return <PeopleIcon size={size} />;
  if (category === 'content') return <PencilIcon size={size} />;
  return <TasksIcon size={size} />;
}

function linkIcon(kind: string) {
  if (kind === 'x') return <XLogoIcon size={14} />;
  if (kind === 'telegram') return <PaperPlaneIcon size={15} />;
  if (kind === 'docs') return <BookOpenIcon size={15} />;
  if (kind === 'github') return <GithubIcon size={15} />;
  return <GlobeIcon size={15} />;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** "5m ago", "3h ago", "2d ago". */
function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Initial({ name, className = '' }: { name: string; className?: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full border border-sun/35 bg-sun-wash font-sans font-semibold text-sun ${className}`}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function ProjectPage({
  data,
  mode,
  onEdit,
  teamSlot,
}: {
  data: ProjectPageData;
  mode: 'workspace' | 'public';
  /** Opens the edit sheet. Only the workspace passes it. */
  onEdit?: () => void;
  /** The team list with its controls, shown in About for the owner and members. */
  teamSlot?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('tasks');
  const [filter, setFilter] = useState<Filter>('all');
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(0);
  const [copied, setCopied] = useState<'' | 'handle' | 'share'>('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Times are relative to the reader's clock, read after mount so the server
  // and the browser render the same first frame.
  useEffect(() => setNow(Date.now()), []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const publicUrl = () => `${window.location.origin}/project/${data.handle}`;

  async function copy(which: 'handle' | 'share') {
    try {
      await navigator.clipboard.writeText(publicUrl());
      setCopied(which);
      window.setTimeout(() => setCopied(''), 1600);
    } catch {
      // Clipboard refused (insecure context or permissions): nothing to undo.
    }
  }

  async function share() {
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: data.name, text: `${data.name} on Flizy`, url: publicUrl() });
        return;
      } catch {
        // Dismissed or refused: fall back to copying.
      }
    }
    await copy('share');
  }

  const isTeam = data.role !== null;
  const live = data.tasks.filter((t) => t.state === 'live');
  const atCap = live.length >= data.liveCap;
  const filtered = data.tasks.filter((t) => {
    if (filter === 'all') return true;
    if (filter === 'live') return t.state === 'live';
    if (filter === 'ended') return t.state !== 'live';
    return t.category === filter;
  });
  const shown = showAll ? filtered : filtered.slice(0, ROWS_BEFORE_ALL);
  const rewardsPaid = data.stats.rewardsPaid;

  // short is the label under 480px, where four full labels do not fit.
  const tabs: Array<{ id: Tab; label: string; short?: string; icon: ReactNode }> = [
    { id: 'tasks', label: 'Tasks', icon: <ListIcon size={16} /> },
    { id: 'rewards', label: 'Rewards', icon: <GiftIcon size={16} /> },
    { id: 'leaderboard', label: 'Leaderboard', short: 'Ranks', icon: <TrophyIcon size={16} /> },
    { id: 'about', label: 'About', icon: <InfoIcon size={16} /> },
  ];

  return (
    <div className="grid gap-4">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        {mode === 'workspace' ? (
          <Link
            href="/dashboard/account?s=projects"
            className="hit-y-44 inline-flex items-center gap-2 font-sans text-base text-[#e6e6e6] no-underline hover:text-white"
          >
            <ArrowLeftIcon size={18} />
            Projects
          </Link>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <button type="button" className={GHOST_BUTTON} onClick={() => void share()}>
            {copied === 'share' ? <CheckIcon size={15} className="text-sun" /> : <ShareIcon size={15} />}
            {copied === 'share' ? 'Link copied' : 'Share'}
          </button>
          {mode === 'workspace' ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                className={`${GHOST_BUTTON} w-10 px-0`}
                aria-label="More"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <MoreVerticalIcon size={16} />
              </button>
              {menuOpen ? (
                <div className="absolute right-0 top-12 z-30 grid min-w-[190px] rounded-[10px] border border-[#2c2c2c] bg-[#121212] p-1 shadow-[0_18px_40px_rgba(0,0,0,0.55)]">
                  {onEdit ? (
                    <MenuItem
                      onClick={() => {
                        setMenuOpen(false);
                        onEdit();
                      }}
                    >
                      <PencilIcon size={14} /> Edit project
                    </MenuItem>
                  ) : null}
                  <Link
                    href={`/project/${encodeURIComponent(data.handle)}`}
                    className="flex h-10 items-center gap-2.5 rounded-[7px] px-3 font-sans text-sm text-[#e6e6e6] no-underline hover:bg-[#1c1c1c]"
                  >
                    <ExternalLinkIcon size={14} /> Public page
                  </Link>
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false);
                      void copy('share');
                    }}
                  >
                    <CopyIcon size={14} /> Copy link
                  </MenuItem>
                </div>
              ) : null}
            </div>
          ) : isTeam ? (
            <Link href={`/dashboard/projects/${encodeURIComponent(data.handle)}`} className={GHOST_BUTTON}>
              Manage
            </Link>
          ) : null}
        </div>
      </div>

      {/* Hero */}
      <section className={`${CARD} relative overflow-hidden`} style={{ background: HERO_GLOW }}>
        {data.banner ? (
          <img
            src={data.banner}
            alt=""
            aria-hidden
            className="pointer-events-none block aspect-[1200/630] w-full select-none object-cover [mask-image:linear-gradient(180deg,#000_75%,transparent)] min-[700px]:absolute min-[700px]:aspect-auto min-[700px]:right-0 min-[700px]:top-0 min-[700px]:h-full min-[700px]:w-[46%] min-[700px]:[mask-image:linear-gradient(90deg,transparent,#000_38%)]"
          />
        ) : null}
        <div className="relative p-5 min-[700px]:w-[62%] min-[700px]:p-6">
          <div className="flex items-start gap-4">
            <ProjectAvatar
              name={data.name}
              image={data.image}
              size={92}
              className="rounded-[18px] shadow-[0_0_36px_rgba(247,208,71,0.14)]"
            />
            <div className="min-w-0 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="m-0 min-w-0 break-words font-sans text-[30px] font-bold leading-tight tracking-wide text-[#f5f5f5]">
                  {data.name}
                </h1>
                {data.verified ? <VerifiedBadge size={22} /> : null}
              </div>
              <button
                type="button"
                onClick={() => void copy('handle')}
                className="hit-y-44 mt-1 inline-flex items-center gap-1.5 font-mono text-sm text-[#a9a9a9] transition-colors hover:text-[#f5f5f5]"
                aria-label="Copy the project link"
              >
                project/{data.handle}
                {copied === 'handle' ? <CheckIcon size={13} className="text-sun" /> : <CopyIcon size={13} />}
              </button>
              {data.role ? (
                <p className="m-0 mt-2">
                  <span
                    className={`rounded-[4px] px-1.5 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide ${
                      data.role === 'owner' ? 'bg-sun text-sun-ink' : 'border border-sun/50 text-sun'
                    }`}
                  >
                    {data.role === 'owner' ? 'Owner' : 'Member'}
                  </span>
                </p>
              ) : null}
            </div>
          </div>
          {data.description ? (
            <p className="m-0 mt-4 text-sm leading-relaxed text-[#d0d0d0]">{data.description}</p>
          ) : null}
          {data.links.length ? (
            <ul className="m-0 mt-4 flex list-none flex-wrap gap-2 p-0">
              {data.links.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener nofollow"
                    className="inline-flex h-10 items-center gap-2 rounded-[8px] border border-[#2e2e2e] bg-[#121212]/90 px-3 font-sans text-sm text-[#e6e6e6] no-underline transition-colors hover:border-sun/50"
                  >
                    <span className="text-[#cfcfcf]">{linkIcon(link.kind)}</span>
                    {link.label}
                    <ExternalLinkIcon size={12} className="text-[#8f8f8f]" />
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 gap-2.5 min-[860px]:grid-cols-4">
        <StatCard icon={<PeopleIcon size={20} />} label="Total participants" value={formatCount(data.stats.participants)}>
          {data.stats.recentInitials.length ? (
            <span className="flex items-center gap-2">
              <span className="flex -space-x-2">
                {data.stats.recentInitials.map((letter, i) => (
                  <Initial key={i} name={letter} className="h-7 w-7 border-[#101010] text-[11px] ring-2 ring-[#101010]" />
                ))}
              </span>
              {data.stats.participants > data.stats.recentInitials.length ? (
                <span className="font-mono text-xs text-[#a9a9a9]">
                  +{formatCount(data.stats.participants - data.stats.recentInitials.length)}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-xs text-muted">No entries yet</span>
          )}
        </StatCard>
        <StatCard icon={<TasksIcon size={20} />} label="Total tasks" value={formatCount(data.stats.totalTasks)}>
          <span className="font-mono text-xs text-[#a9a9a9]">
            {data.stats.liveTasks} Live <span className="px-1 text-[#555]">·</span> {data.stats.endedTasks} Ended
          </span>
        </StatCard>
        <StatCard
          icon={<StarIcon size={20} />}
          label="Total rewards paid"
          value={
            rewardsPaid.length ? (
              <span className="flex flex-wrap items-center gap-x-2">
                {rewardsPaid.map((r) => (
                  <span key={r.asset} className="inline-flex items-center gap-1.5">
                    {r.asset === 'ETH' ? <EthDiamondIcon size={18} className="text-[#d6d6d6]" /> : null}
                    {r.amount} {r.asset}
                  </span>
                ))}
              </span>
            ) : (
              '0 ETH'
            )
          }
        >
          <span className="text-xs text-muted">{rewardsPaid.length ? 'Paid on chain to winners' : 'No rewards paid yet'}</span>
        </StatCard>
        <StatCard icon={<BoltIcon size={20} />} label="Total XP awarded" value={`${formatCount(data.stats.xpTotal)} XP`}>
          <span className="flex items-center gap-1.5 font-mono text-xs text-[#a9a9a9]">
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-sun/40 bg-sun-wash text-sun">
              <StarIcon size={10} />
            </span>
            {data.stats.xpEarners} {data.stats.xpEarners === 1 ? 'earner' : 'earners'}
          </span>
        </StatCard>
      </section>

      {/* Tabs */}
      <div role="tablist" aria-label="Project" className="grid grid-cols-4 border-b border-[#232323]">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`hit-y-44 -mb-px flex h-12 min-w-0 items-center justify-center gap-2 border-b-2 px-1 font-sans text-sm transition-colors ${
              tab === t.id
                ? 'rounded-t-[10px] border-sun bg-sun-wash text-sun ring-1 ring-inset ring-sun/40'
                : 'border-transparent text-[#bdbdbd] hover:text-white'
            }`}
          >
            <span className="hidden min-[420px]:inline">{t.icon}</span>
            {t.short ? (
              <>
                <span className="truncate min-[480px]:hidden">{t.short}</span>
                <span className="hidden truncate min-[480px]:inline">{t.label}</span>
              </>
            ) : (
              <span className="truncate">{t.label}</span>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'tasks' ? (
          <section className={`${CARD} p-4 min-[700px]:p-5`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="m-0 font-sans text-2xl font-semibold tracking-wide text-[#f5f5f5]">Tasks</h2>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-sun/30 bg-sun-wash px-2.5 py-0.5 font-mono text-xs text-sun">
                    <span className="h-1.5 w-1.5 rounded-full bg-sun" aria-hidden />
                    {live.length} live
                  </span>
                </div>
                <p className="m-0 mt-1 text-sm text-muted">Complete tasks, earn XP and rewards.</p>
              </div>
              <div className="flex items-center gap-2">
                {isTeam && data.id ? (
                  atCap ? (
                    <span className={`${PRIMARY_SMALL} cursor-not-allowed opacity-50`} aria-disabled="true" title={`${data.liveCap} tasks are live`}>
                      <PlusIcon size={14} /> New task
                    </span>
                  ) : (
                    <Link href={`/dashboard/explore/new?project=${encodeURIComponent(data.id)}`} className={PRIMARY_SMALL}>
                      <PlusIcon size={14} /> New task
                    </Link>
                  )
                ) : null}
                <label className="relative">
                  <span className="sr-only">Show</span>
                  <select
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value as Filter);
                      setShowAll(false);
                    }}
                    className="hit-y-44 h-10 appearance-none rounded-[8px] border border-[#383838] bg-[#0d0d0d] pl-3.5 pr-9 font-sans text-sm text-[#f5f5f5] outline-none focus:border-sun/70"
                  >
                    <option value="all">All tasks</option>
                    <option value="live">Live</option>
                    <option value="ended">Ended</option>
                    {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <ChevronDownIcon size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#a9a9a9]" />
                </label>
              </div>
            </div>
            {isTeam && atCap ? (
              <p className="m-0 mt-2 text-xs text-muted">
                {data.liveCap} tasks are live. A new one can be published when one ends.
              </p>
            ) : null}

            {shown.length ? (
              <ul className="m-0 mt-4 grid list-none gap-2.5 p-0">
                {shown.map((task) => (
                  <TaskRow key={task.ref} task={task} />
                ))}
              </ul>
            ) : (
              <div className="mt-4 grid justify-items-center gap-2 rounded-[12px] border border-dashed border-[#2a2a2a] px-5 py-10 text-center">
                <TasksIcon size={22} className="text-[#6f6f6f]" />
                <p className="m-0 font-sans text-sm text-[#f5f5f5]">
                  {filter === 'all' ? 'No tasks yet.' : 'No tasks match this filter.'}
                </p>
              </div>
            )}

            {filtered.length > ROWS_BEFORE_ALL ? (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className={`${GHOST_BUTTON} mt-3 w-full`}
              >
                {showAll ? 'Show fewer' : `View all tasks (${filtered.length})`}
                {showAll ? null : <ArrowRightIcon size={14} />}
              </button>
            ) : null}
          </section>
        ) : tab === 'rewards' ? (
          <RewardsList rewards={data.recentRewards} now={now} full />
        ) : tab === 'leaderboard' ? (
          <Leaderboard board={data.leaderboard} />
        ) : (
          <About data={data} teamSlot={teamSlot} now={now} />
        )}
      </div>

      {/* Below the tabs */}
      <section className="grid gap-3 min-[860px]:grid-cols-2">
        <div className={`${CARD} p-4 min-[700px]:p-5`}>
          <CardHeader icon={<TrophyIcon size={18} />} title="Top participants" onAll={() => setTab('leaderboard')} />
          {data.leaderboard.entries.length ? (
            <ol className="m-0 mt-3 grid list-none gap-1 p-0">
              {data.leaderboard.entries.slice(0, 5).map((e) => (
                <li key={e.rank} className="flex items-center gap-3 py-1.5">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] font-mono text-xs font-semibold ${
                      PLACE_BADGE[e.rank - 1] || 'bg-[#1c1c1c] text-[#a9a9a9]'
                    }`}
                  >
                    {e.rank}
                  </span>
                  <Initial name={e.username} className="h-8 w-8 text-xs" />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-sans text-sm text-[#f0f0f0]">
                    {e.username}
                    {e.rank === 1 ? <CrownIcon size={14} className="shrink-0 text-sun" /> : null}
                  </span>
                  <span className="font-mono text-sm text-[#bdbdbd]">{formatCount(e.xp)} XP</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="m-0 mt-3 text-sm text-muted">Winners of tasks with XP appear here.</p>
          )}
        </div>
        <div className={`${CARD} p-4 min-[700px]:p-5`}>
          <CardHeader icon={<GiftIcon size={18} />} title="Recent rewards" onAll={() => setTab('rewards')} />
          <RewardsList rewards={data.recentRewards.slice(0, 5)} now={now} />
        </div>
      </section>
    </div>
  );
}

function MenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 items-center gap-2.5 rounded-[7px] px-3 text-left font-sans text-sm text-[#e6e6e6] hover:bg-[#1c1c1c]"
    >
      {children}
    </button>
  );
}

function StatCard({
  icon,
  label,
  value,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`${CARD} flex flex-col gap-1.5 p-4`}>
      <span className="text-sun">{icon}</span>
      <p className="m-0 mt-1 font-sans text-[13px] text-[#bdbdbd]">{label}</p>
      <p className="m-0 font-sans text-2xl font-bold tracking-wide text-[#f5f5f5]">{value}</p>
      <div className="mt-auto pt-1">{children}</div>
    </div>
  );
}

function CardHeader({ icon, title, onAll }: { icon: ReactNode; title: string; onAll: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="m-0 flex items-center gap-2.5 font-sans text-base font-semibold text-[#f5f5f5]">
        <span className="text-sun">{icon}</span>
        {title}
      </h3>
      <button
        type="button"
        onClick={onAll}
        className="hit-y-44 inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-[#383838] px-3 font-sans text-xs text-[#e6e6e6] hover:border-[#5a5a5a]"
      >
        View all <ArrowRightIcon size={12} />
      </button>
    </div>
  );
}

function TaskRow({ task }: { task: TaskListItem }) {
  const isLive = task.state === 'live';
  const ethReward = /\bETH\b/i.test(task.rewardDisplay);
  return (
    <li className="grid gap-3 rounded-[12px] border border-[#242424] bg-[#0d0d0d] p-3.5 min-[640px]:grid-cols-[1fr_auto_auto] min-[640px]:items-center min-[640px]:gap-4">
      <div className="flex min-w-0 items-start gap-3.5">
        <span
          className={`flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[14px] border ${
            TILE_TONE[task.category || ''] || 'border-[#2e2e2e] bg-[#151515] text-[#bdbdbd]'
          }`}
        >
          {categoryIcon(task.category)}
        </span>
        <div className="min-w-0">
          <p className="m-0 truncate font-sans text-[15px] font-semibold text-[#f5f5f5]">{task.title}</p>
          {task.description ? <p className="m-0 mt-0.5 truncate text-[13px] text-[#a9a9a9]">{task.description}</p> : null}
          {task.category || task.level ? (
            <p className="m-0 mt-2 flex flex-wrap gap-1.5">
              {task.category ? (
                <span className={`rounded-full border px-2 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide ${CATEGORY_TONE[task.category]}`}>
                  {CATEGORY_LABEL[task.category]}
                </span>
              ) : null}
              {task.level ? (
                <span className={`rounded-full border px-2 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide ${LEVEL_TONE}`}>
                  {LEVEL_LABEL[task.level]}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[13px] min-[640px]:grid min-[640px]:gap-1">
        <span className="flex min-w-0 items-center gap-1.5 text-sun">
          {ethReward ? <EthDiamondIcon size={14} className="shrink-0 text-[#d6d6d6]" /> : <GiftIcon size={14} className="shrink-0 text-[#d6d6d6]" />}
          <span className="break-words">{task.rewardDisplay}</span>
        </span>
        <span className="flex items-center gap-1.5 text-[#d8b45a]">
          <BoltIcon size={14} className="shrink-0" />
          {task.xpReward ? `${formatCount(task.xpReward)} XP` : 'No XP'}
        </span>
        <span className="flex items-center gap-1.5 text-[#a9a9a9]">
          <PeopleIcon size={14} className="shrink-0" />
          {formatCount(task.participants)} entered
        </span>
      </div>
      <Link
        href={`/tasks/${task.ref}`}
        className={
          isLive
            ? PRIMARY_SMALL
            : 'hit-y-44 inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[8px] border border-[#383838] px-4 font-sans text-sm text-[#e6e6e6] no-underline hover:border-[#5a5a5a]'
        }
      >
        {isLive ? 'Start' : 'View'}
        <ArrowRightIcon size={14} />
      </Link>
    </li>
  );
}

function RewardsList({ rewards, now, full = false }: { rewards: RecentReward[]; now: number; full?: boolean }) {
  if (!rewards.length) {
    const empty = (
      <p className="m-0 text-sm text-muted">
        No rewards paid yet. When a task with a locked crypto reward picks its winners, each payout shows here with its
        transaction.
      </p>
    );
    return full ? <section className={`${CARD} p-5`}>{empty}</section> : <div className="mt-3">{empty}</div>;
  }
  const list = (
    <ul className="m-0 mt-3 grid list-none gap-1 p-0">
      {rewards.map((r, i) => (
        <li key={`${r.at}-${i}`} className="flex items-center gap-3 py-1.5">
          <Initial name={r.username} className="h-8 w-8 text-xs" />
          <span className="min-w-0 flex-1 truncate font-sans text-sm text-[#f0f0f0]">{r.username}</span>
          <span className="font-mono text-sm text-sun">
            + {r.amount} {r.asset}
          </span>
          <span className="w-14 text-right font-mono text-xs text-[#8f8f8f]">{now ? ago(r.at, now) : ''}</span>
          {r.txUrl ? (
            <a href={r.txUrl} target="_blank" rel="noreferrer noopener" className="text-[#a9a9a9] hover:text-white" aria-label="View transaction">
              <ExternalLinkIcon size={14} />
            </a>
          ) : (
            <span className="w-[14px]" />
          )}
        </li>
      ))}
    </ul>
  );
  return full ? <section className={`${CARD} p-4 min-[700px]:p-5`}>{list}</section> : list;
}

function About({ data, teamSlot, now }: { data: ProjectPageData; teamSlot?: ReactNode; now: number }) {
  return (
    <div className="grid gap-3">
      <section className={`${CARD} p-5`}>
        <h2 className="m-0 font-sans text-lg font-semibold text-[#f5f5f5]">About {data.name}</h2>
        {data.description ? <p className="m-0 mt-2 text-sm leading-relaxed text-[#d0d0d0]">{data.description}</p> : null}
        <dl className="m-0 mt-4 grid gap-2.5 text-sm">
          <Detail label="Project link">project/{data.handle}</Detail>
          <Detail label="Status">
            <span className="inline-flex items-center gap-1.5">
              {data.verified ? <VerifiedBadge size={14} /> : null}
              {data.verified ? 'Verified by Flizy' : 'Standard'}
            </span>
          </Detail>
          {data.createdAt ? (
            <Detail label="Created">
              <LocalWhen iso={data.createdAt} kind="date" />
            </Detail>
          ) : null}
          <Detail label="Live tasks">Up to {data.liveCap} at a time</Detail>
        </dl>
      </section>
      {teamSlot ? teamSlot : null}
      {data.activity.length ? (
        <section className={`${CARD} p-5`}>
          <h3 className="m-0 font-sans text-base font-semibold text-[#f5f5f5]">Recent activity</h3>
          <ul className="m-0 mt-3 grid list-none gap-3 p-0">
            {data.activity.slice(0, 8).map((item, i) => (
              <li key={`${item.at}-${i}`} className="flex items-baseline justify-between gap-3 border-b border-[#1c1c1c] pb-3 last:border-0 last:pb-0">
                <span className="text-sm text-[#e6e6e6]">{item.label}</span>
                <span className="shrink-0 font-mono text-xs text-[#8f8f8f]">{now ? ago(item.at, now) : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#1c1c1c] pb-2.5 last:border-0 last:pb-0">
      <dt className="text-[#8f8f8f]">{label}</dt>
      <dd className="m-0 text-right font-mono text-[#e6e6e6]">{children}</dd>
    </div>
  );
}
