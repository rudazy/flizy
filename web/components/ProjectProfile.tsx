'use client';

import { useState } from 'react';
import { TaskCard, type TaskCardData } from './TaskCard';
import { LocalWhen } from './LocalWhen';

/**
 * Tasks and the record of what the project has done.
 *
 * Two panels, not three. A bounty is a task until it is a different object,
 * and an empty tab would only look like a feature.
 */
export function ProjectProfile({
  tasks,
  activity,
}: {
  tasks: TaskCardData[];
  activity: Array<{ at: string; label: string }>;
}) {
  const [tab, setTab] = useState<'tasks' | 'activity'>('tasks');

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-1 rounded-md border border-border p-1" role="tablist">
        {(
          [
            ['tasks', 'Tasks'],
            ['activity', 'Activity'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-2 font-sans text-sm tracking-wide transition-colors ${
              tab === id ? 'bg-lime/10 text-lime' : 'text-muted hover:text-paper'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'tasks' ? (
        tasks.length ? (
          <div className="grid gap-4">
            {tasks.map((task) => (
              <TaskCard key={task.ref} task={task} />
            ))}
          </div>
        ) : (
          <p className="m-0 text-sm text-muted">No tasks yet.</p>
        )
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
