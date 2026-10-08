import type { ProjectLeaderboard } from '../lib/tasks';

/**
 * Who has earned XP from a project, highest first. Shared by the workspace and
 * the public project page, so both rank and word it the same way.
 */

const CARD = 'rounded-[12px] border border-[#232323] bg-[#101010]';

/** Gold, silver and bronze for the first three places. No blue anywhere. */
const PLACE_TONE = ['text-sun border-sun/50 bg-sun-wash', 'text-[#d8d8d8] border-[#6a6a6a] bg-[#171717]', 'text-[#c89a62] border-[#7a5a35] bg-[#1a140d]'];

export function Leaderboard({ board }: { board: ProjectLeaderboard }) {
  if (!board.entries.length) {
    return (
      <section className={`${CARD} grid justify-items-center gap-2 px-5 py-10 text-center`}>
        <p className="m-0 font-sans text-sm text-[#f5f5f5]">No XP awarded yet.</p>
        <p className="m-0 max-w-[320px] text-xs text-muted">
          Set an XP reward on a task. When its winners are published, they appear here.
        </p>
      </section>
    );
  }
  return (
    <section className={CARD}>
      <ol className="m-0 list-none p-0">
        {board.entries.map((entry) => (
          <li key={entry.rank} className="flex items-center gap-3 border-b border-[#1c1c1c] px-4 py-3 last:border-b-0">
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-semibold ${
                PLACE_TONE[entry.rank - 1] || 'border-[#2e2e2e] text-[#a9a9a9]'
              }`}
            >
              {entry.rank}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-sans text-sm text-[#f5f5f5]">@{entry.username}</span>
              <span className="block text-xs text-muted">
                {entry.wins} {entry.wins === 1 ? 'win' : 'wins'}
              </span>
            </span>
            <span className="font-mono text-sm font-semibold text-sun">{entry.xp.toLocaleString('en-US')} XP</span>
          </li>
        ))}
      </ol>
      {board.earners > board.entries.length ? (
        <p className="m-0 border-t border-[#1c1c1c] px-4 py-3 text-xs text-muted">
          Top {board.entries.length} of {board.earners}.
        </p>
      ) : null}
    </section>
  );
}
