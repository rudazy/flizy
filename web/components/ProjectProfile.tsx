'use client';

import { useState } from 'react';
import type { ProjectLeaderboard } from '../lib/tasks';
import { TaskCard, type TaskCardData } from './TaskCard';
import { LocalWhen } from './LocalWhen';
import { Leaderboard } from './ProjectLeaderboard';

/**
 * Tasks, the XP leaderboard, and the record of what the project has done.
 *
 * Tasks are split by whether they still take entries, so somebody arriving
 * from a shared link sees what they can join first.
 */
type Tab = 'live' | 'ended' | 'leaderboard' | 'activity';

export function ProjectProfile({
  tasks,
  activity,
  leaderboard,
}: {
  tasks: TaskCardData[];
  activity: Array<{ at: string; label: string }>;
  leaderboard: ProjectLeaderboard;
}) {
  const [tab, setTab] = useState<Tab>('live');
  const live = tasks.filter((t) => t.state === 'live');
  const ended = tasks.filter((t) => t.state !== 'live');

  // The third entry is the label under 480px, where four full labels do not fit.
  const tabs: Array<[Tab, string, string | null, number | null]> = [
    ['live', 'Live', null, live.length],
    ['ended', 'Ended', null, ended.length],
    ['leaderboard', 'Leaderboard', 'XP', leaderboard.earners],
    ['activity', 'Activity', null, null],
  ];

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-4 gap-1 rounded-md border border-border p-1" role="tablist">
        {tabs.map(([id, label, short, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex min-w-0 items-center justify-center gap-1 rounded-md px-1 py-2 font-sans text-[13px] tracking-wide transition-colors ${
              tab === id ? 'bg-lime/10 text-lime' : 'text-muted hover:text-paper'
            }`}
          >
            {short ? (
              <>
                <span className="truncate min-[480px]:hidden">{short}</span>
                <span className="hidden truncate min-[480px]:inline">{label}</span>
              </>
            ) : (
              <span className="truncate">{label}</span>
            )}
            {count !== null ? <span className="font-mono text-[10px] opacity-70">{count}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'live' || tab === 'ended' ? (
        (tab === 'live' ? live : ended).length ? (
          <div className="grid gap-4">
            {(tab === 'live' ? live : ended).map((task) => (
              <TaskCard key={task.ref} task={task} />
            ))}
          </div>
        ) : (
          <p className="m-0 text-sm text-muted">{tab === 'live' ? 'No live tasks right now.' : 'No ended tasks yet.'}</p>
        )
      ) : tab === 'leaderboard' ? (
        <Leaderboard board={leaderboard} />
      ) : activity.length ? (
        <ul className="m-0 grid list-none gap-3 p-0">
          {activity.map((item, i) => (
            <li key={`${item.at}-${i}`} className="border-b border-border pb-3 last:border-0">
              <p className="m-0 text-sm text-paper">{item.label}</p>
              <p className="m-0 text-xs text-muted">
                <LocalWhen iso={item.at} kind="instant" />
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted">Nothing has happened yet.</p>
      )}
    </div>
  );
}
