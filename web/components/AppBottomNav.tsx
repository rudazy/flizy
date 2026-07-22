'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  {
    href: '/dashboard',
    label: 'Home',
    match: (p: string) => p === '/dashboard',
    icon: HomeIcon,
  },
  {
    href: '/dashboard/wallet',
    label: 'Wallet',
    match: (p: string) => p.startsWith('/dashboard/wallet'),
    icon: WalletIcon,
  },
  {
    href: '/dashboard/history',
    label: 'History',
    match: (p: string) => p.startsWith('/dashboard/history'),
    icon: HistoryIcon,
  },
  {
    href: '/dashboard/account',
    label: 'Account',
    match: (p: string) => p.startsWith('/dashboard/account'),
    icon: AccountIcon,
  },
] as const;

function TabLinks({ compact }: { compact?: boolean }) {
  const pathname = usePathname() || '';
  return (
    <>
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={
              compact
                ? `flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 no-underline transition-colors ${
                    active ? 'text-lime' : 'text-muted hover:text-paper'
                  }`
                : `rounded-md px-3 py-2 font-sans text-sm no-underline transition-colors ${
                    active
                      ? 'bg-lime/10 text-lime'
                      : 'text-muted hover:bg-surface hover:text-paper'
                  }`
            }
            aria-current={active ? 'page' : undefined}
          >
            {compact ? (
              <>
                <Icon active={active} />
                <span className="font-sans text-[10px] font-medium tracking-wide">{tab.label}</span>
              </>
            ) : (
              tab.label
            )}
          </Link>
        );
      })}
    </>
  );
}

/** Desktop horizontal tabs (place under the top bar). */
export function AppDesktopTabs() {
  return (
    <nav className="flex gap-1 border-b border-border pb-3" aria-label="App sections">
      <TabLinks />
    </nav>
  );
}

/** Mobile fixed bottom bar only. */
export function AppBottomNav() {
  return (
    <nav
      className="app-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t border-border bg-ink/95 backdrop-blur-md md:hidden"
      aria-label="App"
    >
      <div className="mx-auto flex max-w-lg items-stretch justify-around px-1 pb-[env(safe-area-inset-bottom)] pt-1">
        <TabLinks compact />
      </div>
    </nav>
  );
}

function HomeIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1v-9.5z"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function WalletIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="6"
        width="18"
        height="13"
        rx="2"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.5}
      />
      <path d="M3 10h18" stroke="currentColor" strokeWidth={active ? 2 : 1.5} />
      <circle cx="16.5" cy="14.5" r="1.25" fill="currentColor" />
    </svg>
  );
}

function HistoryIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={active ? 2 : 1.5} />
      <path
        d="M12 8v4.5l3 1.5"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AccountIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="9" r="3.5" stroke="currentColor" strokeWidth={active ? 2 : 1.5} />
      <path
        d="M5 19.5c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}
