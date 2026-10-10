'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppPage, AppSlideNav, useSlide } from '../../../components/AppSection';
import { TaskCard, type TaskCardData } from '../../../components/TaskCard';
import { ExploreTokens } from '../../../components/ExploreTokens';
import { ExploreNfts } from '../../../components/ExploreNfts';
import { ComingSoonPanel, useComingSoon } from '../../../components/ComingSoon';
import {
  AirdropIcon,
  ArrowRightIcon,
  BellIcon,
  BoltIcon,
  ContentIcon,
  HistoryIcon,
  NftsIcon,
  OnchainIcon,
  PartnerIcon,
  PeopleIcon,
  PlusIcon,
  SocialIcon,
  TasksIcon,
  TokensIcon,
} from '../../../components/ExploreIcons';

/**
 * Explore: tokens to look at and trade, tasks to do, collections to compare.
 *
 * Tokens is the open slide: discovery, a token page, and copy trade. Tasks
 * comes second. NFTs is last: the listed set plus copy mint.
 */
const SLIDES = ['tokens', 'tasks', 'nfts'] as const;

export default function ExplorePage() {
  const [slide, setSlide] = useSlide(SLIDES, 'tokens');

  return (
    <AppPage>
      <AppTopBar title="Explore" />
      {/* The header's padding and margin suit the other pages; here the tabs
          sit closer under it. */}
      <div className="!-mt-[17px]">
        <AppSlideNav
          variant="tabs"
          items={[
            { id: 'tokens', label: 'Tokens', icon: <TokensIcon size={17} /> },
            { id: 'tasks', label: 'Tasks', icon: <TasksIcon size={17} /> },
            { id: 'nfts', label: 'NFTs', icon: <NftsIcon size={17} /> },
          ]}
          activeId={slide}
          onSelect={setSlide}
        />
      </div>
      {slide === 'tasks' ? <TasksSlide /> : null}
      {slide === 'tokens' ? <ExploreTokens /> : null}
      {slide === 'nfts' ? <ExploreNfts /> : null}
    </AppPage>
  );
}

type TaskList = 'live' | 'ended' | 'mine';

/**
 * Category chips. The ones with a `stored` value filter by the category a task
 * was published with. Airdrop and Partner are not categories a task can carry
 * yet, so they open a Coming soon panel.
 */
const CATEGORIES: Array<{ id: string; label: string; icon?: ReactNode; stored?: string }> = [
  { id: 'all', label: 'All' },
  { id: 'airdrop', label: 'Airdrop', icon: <AirdropIcon size={13} /> },
  { id: 'social', label: 'Social', icon: <SocialIcon size={13} />, stored: 'social' },
  { id: 'onchain', label: 'On-chain', icon: <OnchainIcon size={13} />, stored: 'onchain' },
  { id: 'community', label: 'Community', icon: <PeopleIcon size={13} />, stored: 'community' },
  { id: 'content', label: 'Content', icon: <ContentIcon size={13} />, stored: 'content' },
  { id: 'partner', label: 'Partner', icon: <PartnerIcon size={13} /> },
];

function TasksSlide() {
  const [list, setList] = useState<TaskList>('live');
  const [category, setCategory] = useState('all');
  const [tasks, setTasks] = useState<TaskCardData[] | null>(null);
  const [error, setError] = useState('');
  const [canCreate, setCanCreate] = useState(false);
  const [comingSoon, comingSoonNote] = useComingSoon();
  const listTop = useRef<HTMLDivElement>(null);

  const load = useCallback(async (which: TaskList) => {
    setTasks(null);
    setError('');
    try {
      const res = await fetch(`/api/tasks?state=${which}`);
      const body = await res.json();
      if (body?.tasks) setTasks(body.tasks as TaskCardData[]);
      else setError(body?.error || 'Could not load tasks.');
    } catch {
      setError('Could not load tasks.');
    }
  }, []);

  useEffect(() => {
    load(list);
  }, [list, load]);

  const chosen = CATEGORIES.find((c) => c.id === category) || CATEGORIES[0];
  const comingSoonCategory = chosen.id !== 'all' && !chosen.stored;
  const shown = tasks && chosen.stored ? tasks.filter((t) => t.category === chosen.stored) : tasks;

  // The button appears only for an account that can actually use it. This reads
  // the capability the route reports, not its status code: the route answers
  // 200 to any signed-in account, so a 200 says nothing about permission.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/projects');
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setCanCreate(res.ok && body?.canCreate === true);
      } catch {
        /* no button is the right fallback */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function exploreCampaigns() {
    setList('live');
    setCategory('all');
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    // Full width of the shell, the same as Home and Wallet, on a phone and a desktop.
    <div className="grid w-full">
      <div className="mt-[-3px] flex items-end gap-[14px]">
        <div
          className="mb-[3px] flex flex-1 items-end gap-[10px] border-b border-[#1e2024]"
          role="tablist"
          aria-label="Task lists"
        >
          <ListTab label="Live" active={list === 'live'} onClick={() => setList('live')} />
          <ListTab label="Ended" active={list === 'ended'} onClick={() => setList('ended')} />
          <ListTab label="My tasks" active={list === 'mine'} onClick={() => setList('mine')} />
        </div>
        {canCreate ? (
          <Link
            href="/dashboard/explore/new"
            className="btn-sun hit-y-44 h-[26px] shrink-0 gap-[8px] rounded-[5px] pl-[13px] pr-[14px] font-sans text-[9.5px] no-underline"
          >
            <PlusIcon size={11} strokeWidth={2.6} />
            Create
          </Link>
        ) : null}
      </div>

      <Hero onExplore={exploreCampaigns} />

      <div
        ref={listTop}
        className="-mx-4 -mb-[8px] mt-[6px] flex scroll-mt-24 gap-[7px] overflow-x-auto py-[8px] pl-[11px] pr-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="Task categories"
      >
        {CATEGORIES.map((c) => {
          const active = c.id === category;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              aria-pressed={active}
              className={`hit-y-44 inline-flex h-[28px] shrink-0 items-center gap-[6px] rounded-[6px] border font-sans text-[7.5px] font-medium ${
                active
                  ? `border-[1.5px] border-sun bg-sun-wash text-sun ${c.icon ? 'pl-[7px] pr-[6px]' : 'px-[11px]'}`
                  : `border-chrome-line bg-[#0f1013] text-[#d9d9d9] ${c.icon ? 'pl-[7px] pr-[6px]' : 'px-[11px]'}`
              }`}
            >
              {c.icon ? <span className={active ? 'text-sun' : 'text-[#d4d4d4]'}>{c.icon}</span> : null}
              {c.label}
            </button>
          );
        })}
      </div>

      <div className="mt-[14px]">
        {comingSoonCategory ? <ComingSoonPanel what={`${chosen.label} tasks`} /> : null}
        {!comingSoonCategory ? (
          <>
            {error ? <p className="alert alert-error">{error}</p> : null}

            {tasks === null && !error ? (
              <p className="py-10 text-center font-sans text-sm text-[#9d9d9d]">Loading...</p>
            ) : null}

            {shown && shown.length === 0 && tasks && tasks.length > 0 ? (
              <EmptyState
                title={`No ${chosen.label} tasks`}
                lines={[`Nothing in ${chosen.label} on this list right now.`, 'Try another category or see them all.']}
              >
                <button
                  type="button"
                  onClick={() => setCategory('all')}
                  className="btn-chrome hit-y-44 h-[30px] gap-[8px] rounded-[6px] px-[15px] font-sans text-[9px]"
                >
                  Show all tasks
                </button>
              </EmptyState>
            ) : null}

            {tasks && tasks.length === 0 ? (
              list === 'live' ? (
                <EmptyState
                  title="Nothing live right now"
                  lines={['No tasks are open at the moment.', 'Check back soon or look at what has already run.']}
                >
                  <button
                    type="button"
                    onClick={() => comingSoon('Notify me')}
                    className="btn-sun hit-y-44 h-[30px] gap-[8px] rounded-[6px] pl-[20px] pr-[18px] font-sans text-[9px]"
                  >
                    <BellIcon size={13} strokeWidth={2} />
                    Notify me
                  </button>
                  <button
                    type="button"
                    onClick={() => setList('ended')}
                    className="btn-chrome hit-y-44 h-[30px] gap-[8px] rounded-[6px] pl-[15px] pr-[13px] font-sans text-[9px]"
                  >
                    <HistoryIcon size={13} />
                    View ended campaigns
                  </button>
                </EmptyState>
              ) : list === 'ended' ? (
                <EmptyState
                  title="Nothing finished yet"
                  lines={['Finished tasks stay here,', 'with their winners once they are chosen.']}
                >
                  <button
                    type="button"
                    onClick={() => setList('live')}
                    className="btn-chrome hit-y-44 h-[30px] gap-[8px] rounded-[6px] px-[15px] font-sans text-[9px]"
                  >
                    View live campaigns
                  </button>
                </EmptyState>
              ) : (
                <EmptyState
                  title="No tasks of yours yet"
                  lines={['Tasks you save, join or publish', 'are kept here in one place.']}
                >
                  <button
                    type="button"
                    onClick={() => setList('live')}
                    className="btn-chrome hit-y-44 h-[30px] gap-[8px] rounded-[6px] px-[15px] font-sans text-[9px]"
                  >
                    Browse live tasks
                  </button>
                </EmptyState>
              )
            ) : null}

            {shown && shown.length > 0 ? (
              <div className="grid gap-4">
                {shown.map((task) => (
                  <TaskCard key={task.ref} task={task} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {comingSoonNote}
    </div>
  );
}

function ListTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`hit-y-44 -mb-px border-b-2 px-3 pb-[6px] pt-1 font-sans text-[8.5px] font-medium uppercase tracking-[0.02em] transition-colors ${
        active ? 'border-sun text-sun' : 'border-transparent text-[#b9b9b9] hover:text-[#e6e6e6]'
      }`}
    >
      {label}
    </button>
  );
}

const HERO_SLIDES = 4;

/**
 * The first slide is the campaigns banner. The other three are not built yet,
 * so they open with "Coming soon" in the middle of the same card.
 */
function Hero({ onExplore }: { onExplore: () => void }) {
  const [slide, setSlide] = useState(0);
  return (
    <section
      className="relative mt-[13px] h-[179px] overflow-hidden rounded-[10px] border border-[#2e2a24]"
      style={{
        background:
          'radial-gradient(120% 130% at 0% 100%, rgba(40, 32, 14, 0.9) 0%, rgba(26, 22, 13, 0) 60%), linear-gradient(90deg, #1a160d 0%, #131110 48%, #0e0e0f 100%)',
      }}
      aria-label="Tasks"
      aria-roledescription="carousel"
    >
      {slide === 0 ? (
        <>
          <Image
            src="/explore/tasks-hero.png"
            alt=""
            width={150}
            height={175}
            unoptimized
            priority
            className="pointer-events-none absolute right-[2px] top-[2px] h-[175px] w-[150px] select-none"
            style={{ WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, #000 22%)', maskImage: 'linear-gradient(90deg, transparent 0%, #000 22%)' }}
          />
          <div className="relative pl-[16px] pt-[8px]">
            <span className="inline-flex h-[19px] items-center gap-[4px] rounded-[4px] border border-[#2b2618] bg-[#0f0d0b] px-[7px] font-sans text-[7px] font-medium text-sun">
              <BoltIcon size={8} />
              Complete tasks, earn rewards
            </span>
            <h2 className="mt-[7px] font-sans text-[17.5px] font-bold leading-[20.5px] text-white">
              Discover campaigns
              <br />
              and <span className="text-sun">earn rewards</span>
            </h2>
            <p className="mt-[8px] max-w-[200px] font-sans text-[9.3px] leading-[12.5px] text-[#c4c4c4]">
              Join campaigns from top projects, complete tasks and earn tokens, NFTs and more.
            </p>
            <button
              type="button"
              onClick={onExplore}
              className="btn-sun hit-y-44 mt-[10px] h-[28px] gap-[9px] rounded-[5px] pl-[14px] pr-[13px] font-sans text-[8.8px]"
            >
              Explore Campaigns
              <ArrowRightIcon size={11} strokeWidth={2.4} />
            </button>
          </div>
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center pb-[12px] text-center" aria-live="polite">
          <h2 className="font-sans text-[17.5px] font-bold text-sun">Coming soon</h2>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-[9px] flex justify-center gap-[6.8px]">
        {Array.from({ length: HERO_SLIDES }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSlide(i)}
            aria-label={`Slide ${i + 1} of ${HERO_SLIDES}`}
            aria-current={slide === i}
            className="hit-y-44 -m-[6px] p-[6px]"
          >
            <span className={`block h-[6px] w-[6px] rounded-full ${slide === i ? 'bg-sun' : 'bg-[#2c2d31]'}`} />
          </button>
        ))}
      </div>
    </section>
  );
}

function EmptyState({
  title,
  lines,
  children,
}: {
  title: string;
  lines: string[];
  children: ReactNode;
}) {
  return (
    <section
      className="flex min-h-[297px] flex-col items-center rounded-[9px] border border-chrome-card-line px-4 pb-8 text-center"
      style={{ background: 'linear-gradient(180deg, #111111 0%, #0c0c0d 100%)' }}
    >
      <Image
        src="/explore/tasks-empty.png"
        alt=""
        width={133}
        height={104}
        unoptimized
        className="pointer-events-none mt-[40px] h-[104px] w-[133px] select-none"
        style={{
          WebkitMaskImage: 'radial-gradient(closest-side, #000 72%, transparent 100%)',
          maskImage: 'radial-gradient(closest-side, #000 72%, transparent 100%)',
        }}
      />
      <h3 className="mt-[6px] font-sans text-[15.5px] font-bold text-white">{title}</h3>
      <p className="mt-[7px] font-sans text-[10px] leading-[13px] text-[#a9a9a9]">
        {lines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </p>
      <div className="mt-[18px] flex flex-wrap items-center justify-center gap-[7.5px]">{children}</div>
    </section>
  );
}
