'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppPage, AppSection, AppSlideNav, useSlide } from '../../../components/AppSection';
import { TaskCard, type TaskCardData } from '../../../components/TaskCard';
import { ExploreTokens } from '../../../components/ExploreTokens';
import { ExploreNfts } from '../../../components/ExploreNfts';

/**
 * Explore: tasks to do, tokens to look at and trade, collections to compare.
 *
 * Tasks stays the open slide. Tokens is discovery, a token page, and copy
 * trade. NFTs is the listed set plus copy mint.
 */
const SLIDES = ['tasks', 'tokens', 'nfts'] as const;
const LISTS = ['live', 'ended'] as const;

export default function ExplorePage() {
  const [slide, setSlide] = useSlide(SLIDES, 'tasks');

  return (
    <AppPage>
      <AppTopBar title="Explore" />
      <AppSlideNav
        items={[
          { id: 'tasks', label: 'Tasks' },
          { id: 'tokens', label: 'Tokens' },
          { id: 'nfts', label: 'NFTs' },
        ]}
        activeId={slide}
        onSelect={setSlide}
      />
      {slide === 'tasks' ? <TasksSlide /> : null}
      {slide === 'tokens' ? <ExploreTokens /> : null}
      {slide === 'nfts' ? <ExploreNfts /> : null}
    </AppPage>
  );
}

function TasksSlide() {
  const [list, setList] = useState<(typeof LISTS)[number]>('live');
  const [tasks, setTasks] = useState<TaskCardData[] | null>(null);
  const [error, setError] = useState('');
  const [canCreate, setCanCreate] = useState(false);

  const load = useCallback(async (which: (typeof LISTS)[number]) => {
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

  // The button appears only for an account that can actually use it. This reads
  // the capability the route reports, not its status code: the route answers
  // 200 to any signed-in account, so treating that as permission showed the
  // button to everybody and sent them to a page that refuses.
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

  return (
    // The shell widens to 1200px from the small breakpoint. This column stays
    // narrow so a card and its create control stay next to each other. A fixed
    // button would not: the shell animates a transform, and a transformed
    // ancestor becomes the box a fixed child is positioned against.
    <div className="grid w-full max-w-lg gap-4">
      <div className="flex items-center gap-2">
        <div
          className="grid flex-1 grid-cols-2 gap-1 rounded-md border border-border p-1"
          role="tablist"
          aria-label="Task lists"
        >
          {LISTS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={list === id}
              onClick={() => setList(id)}
              className={`rounded-md px-3 py-2 font-sans text-sm uppercase tracking-wide transition-colors ${
                list === id ? 'bg-lime/10 text-lime' : 'text-muted hover:text-paper'
              }`}
            >
              {id}
            </button>
          ))}
        </div>
        {canCreate ? (
          <Link
            href="/dashboard/explore/new"
            className="btn btn-primary shrink-0 no-underline !px-3"
            aria-label="Create task"
          >
            +
          </Link>
        ) : null}
      </div>

      {error ? <p className="alert alert-error">{error}</p> : null}

      {tasks === null && !error ? <p className="text-sm text-muted">Loading...</p> : null}

      {tasks && tasks.length === 0 ? (
        <AppSection title={list === 'live' ? 'Nothing live' : 'Nothing finished yet'}>
          <p className="text-sm text-muted">
            {list === 'live'
              ? 'No tasks are open right now. Check back, or look at what has already run.'
              : 'Finished tasks stay here, with their winners once they are chosen.'}
          </p>
        </AppSection>
      ) : null}

      {tasks && tasks.length > 0 ? (
        <div className="grid gap-4">
          {tasks.map((task) => (
            <TaskCard key={task.ref} task={task} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
