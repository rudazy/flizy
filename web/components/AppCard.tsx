import type { ReactNode } from 'react';

/**
 * The card the Home and Wallet screens are built from: a near-black panel with
 * a hairline border, and a header of gold icon tile, title, one line under it
 * and an optional action on the right. AppCollapsibleCard is the same card
 * with its body behind the header.
 */

export function AppCard({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <section className={`rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] ${className}`}>{children}</section>
  );
}

export function AppCardHeader({
  icon,
  title,
  subtitle,
  action = null,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-[13px]">
        <span className="flex h-[29.5px] w-[29.5px] shrink-0 items-center justify-center rounded-[5px] border border-[#3a3017] bg-[#1c180c] text-sun">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="m-0 font-sans text-[12.3px] font-semibold leading-[15px] text-white">{title}</h2>
          <p className="m-0 mt-[1px] truncate font-sans text-[8.6px] text-[#b5b5b5]">{subtitle}</p>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * A card whose body opens on tap. The whole header is the button, with a
 * chevron that turns when open. Spans rather than a heading inside it: a
 * button may only hold phrasing content.
 */
export function AppCollapsibleCard({
  id,
  icon,
  title,
  subtitle,
  open,
  onToggle,
  children,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <AppCard className="px-[12px] py-[12.5px]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 items-center gap-[13px]">
          <span className="flex h-[29.5px] w-[29.5px] shrink-0 items-center justify-center rounded-[5px] border border-[#3a3017] bg-[#1c180c] text-sun">
            {icon}
          </span>
          <span className="min-w-0">
            <span className="block font-sans text-[12.3px] font-semibold leading-[15px] text-white">{title}</span>
            <span className="mt-[1px] block truncate font-sans text-[8.6px] text-[#b5b5b5]">{subtitle}</span>
          </span>
        </span>
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[4px] border border-[#2a2b30] bg-[#0f0f10] text-[#d9d9d9]">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          >
            <path d="M6.5 9.5L12 15l5.5-5.5" />
          </svg>
        </span>
      </button>
      {open ? <div id={id}>{children}</div> : null}
    </AppCard>
  );
}
