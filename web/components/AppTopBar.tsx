'use client';

import Link from 'next/link';
import { AppDesktopTabs } from './AppBottomNav';
import { useDashboard } from './DashboardProvider';
import { useComingSoon } from './ComingSoon';
import { BellIcon, RefreshIcon, SearchIcon } from './ExploreIcons';

type AppTopBarProps = {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
  actionBusy?: boolean;
};

const ICON_BUTTON =
  'hit-44 flex h-[34px] w-[34px] items-center justify-center rounded-[8px] border border-chrome-line bg-chrome-fill text-[#d6d6d6] transition-colors hover:text-white';

export function AppTopBar({
  title,
  actionLabel,
  onAction,
  actionHref,
  actionBusy,
}: AppTopBarProps) {
  const { data } = useDashboard();
  // Who is signed in, by @username, else the display name. Never the email: it
  // is personal, and this line is on every page and in every screenshot.
  const username = data?.account.username;
  const subtitle = username ? `@${username}` : data?.account.display_name || '';
  const [comingSoon, comingSoonNote] = useComingSoon();

  return (
    <>
      <header className="sticky top-0 z-40 -mx-4 mb-5 bg-ink/90 px-4 pb-3 pt-[max(0.7rem,env(safe-area-inset-top))] backdrop-blur-md sm:-mx-6 sm:px-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/dashboard"
              className="hit-44 flex h-[33px] w-[33px] shrink-0 items-center justify-center rounded-[7px] border border-[#292a2f] bg-[#111010] font-sans text-[18px] font-bold text-sun no-underline"
              aria-label="Flizy home"
            >
              F
            </Link>
            <div className="min-w-0">
              <h1 className="truncate font-sans text-[15.5px] font-semibold leading-tight tracking-wide text-[#f5f5f5]">
                {title}
              </h1>
              {subtitle ? (
                <p className="truncate font-sans text-[12px] leading-snug text-[#9d9d9d]">
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-[11px]">
            {actionLabel && actionHref ? (
              <a
                href={actionHref}
                className="btn btn-primary shrink-0 !px-3 !py-1.5 text-xs no-underline"
                target={actionHref.startsWith('http') ? '_blank' : undefined}
                rel={actionHref.startsWith('http') ? 'noreferrer' : undefined}
              >
                {actionLabel}
              </a>
            ) : null}
            {actionLabel && onAction ? (
              <button
                type="button"
                className="btn-sun hit-y-44 h-[34px] shrink-0 gap-[8px] rounded-[5px] px-[10px] font-sans text-[11px] font-semibold"
                onClick={onAction}
                disabled={actionBusy}
              >
                <RefreshIcon size={14} className={actionBusy ? 'animate-spin' : undefined} />
                {actionLabel}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => comingSoon('Search')}
              className={ICON_BUTTON}
              aria-label="Search, coming soon"
            >
              <SearchIcon size={17} />
            </button>
            <button
              type="button"
              onClick={() => comingSoon('Notifications')}
              className={ICON_BUTTON}
              aria-label="Notifications, coming soon"
            >
              <BellIcon size={17} />
              <span
                className="absolute right-[5px] top-[6px] h-[6px] w-[6px] rounded-full bg-sun"
                aria-hidden
              />
            </button>
          </div>
        </div>
        <div className="mt-3 hidden md:block">
          <AppDesktopTabs />
        </div>
      </header>
      {/* Outside the header: its backdrop filter would pin a fixed child to it. */}
      {comingSoonNote}
    </>
  );
}
