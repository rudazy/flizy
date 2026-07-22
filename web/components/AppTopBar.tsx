'use client';

import Link from 'next/link';
import { AppDesktopTabs } from './AppBottomNav';
import { useDashboard } from './DashboardProvider';

type AppTopBarProps = {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
  actionBusy?: boolean;
};

export function AppTopBar({
  title,
  actionLabel,
  onAction,
  actionHref,
  actionBusy,
}: AppTopBarProps) {
  const { data } = useDashboard();
  const subtitle = data?.account.display_name || data?.account.email || '';

  return (
    <header className="sticky top-0 z-40 -mx-4 mb-5 border-b border-border/80 bg-ink/90 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] backdrop-blur-md sm:-mx-6 sm:px-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href="/dashboard"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface font-sans text-sm font-semibold text-lime no-underline shadow-glow"
              aria-label="Flizy home"
            >
              F
            </Link>
            <div className="min-w-0">
              <h1 className="truncate font-sans text-base font-semibold tracking-wide text-paper">
                {title}
              </h1>
              {subtitle ? (
                <p className="truncate text-[11px] text-muted">{subtitle}</p>
              ) : null}
            </div>
          </div>
        </div>
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
            className="btn btn-primary shrink-0 !px-3 !py-1.5 text-xs"
            onClick={onAction}
            disabled={actionBusy}
          >
            {actionBusy ? '...' : actionLabel}
          </button>
        ) : null}
      </div>
      <div className="mt-3 hidden md:block">
        <AppDesktopTabs />
      </div>
    </header>
  );
}
