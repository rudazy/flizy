'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLocale } from './LocaleProvider';
import type { MessageKey } from '../lib/i18n/messages';

const LEFT_TABS: Array<{
  href: string;
  labelKey: MessageKey;
  match: (p: string) => boolean;
  icon: (p: { active: boolean }) => JSX.Element;
}> = [
  {
    href: '/dashboard',
    labelKey: 'nav.home',
    match: (p: string) => p === '/dashboard',
    icon: HomeIcon,
  },
  {
    href: '/dashboard/wallet',
    labelKey: 'nav.wallet',
    match: (p: string) => p.startsWith('/dashboard/wallet'),
    icon: WalletIcon,
  },
];

const RIGHT_TABS: Array<{
  href: string;
  labelKey: MessageKey;
  match: (p: string) => boolean;
  icon: (p: { active: boolean }) => JSX.Element;
}> = [
  {
    href: '/dashboard/history',
    labelKey: 'nav.history',
    match: (p: string) => p.startsWith('/dashboard/history'),
    icon: HistoryIcon,
  },
  {
    href: '/dashboard/account',
    labelKey: 'nav.account',
    match: (p: string) => p.startsWith('/dashboard/account'),
    icon: AccountIcon,
  },
];

function CompactTab({
  href,
  label,
  active,
  Icon,
}: {
  href: string;
  label: string;
  active: boolean;
  Icon: (p: { active: boolean }) => JSX.Element;
}) {
  return (
    <Link
      href={href}
      className={`flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 no-underline transition-colors ${
        active ? 'text-lime' : 'text-muted hover:text-paper'
      }`}
      aria-current={active ? 'page' : undefined}
    >
      <Icon active={active} />
      <span className="font-sans text-[10px] font-medium tracking-wide">{label}</span>
    </Link>
  );
}

function SwapPill({ compact }: { compact?: boolean }) {
  const pathname = usePathname() || '';
  const { t } = useLocale();
  const active = pathname.startsWith('/dashboard/swap');
  const label = t('nav.swap');

  if (!compact) {
    return (
      <Link
        href="/dashboard/swap"
        className={`rounded-md px-4 py-2 font-sans text-sm font-semibold no-underline transition-colors ${
          active ? 'bg-lime text-ink' : 'bg-lime/90 text-ink hover:bg-lime'
        }`}
        aria-current={active ? 'page' : undefined}
      >
        {label}
      </Link>
    );
  }

  return (
    <Link
      href="/dashboard/swap"
      className="relative -mt-4 flex min-w-[72px] flex-col items-center justify-end no-underline"
      aria-current={active ? 'page' : undefined}
      aria-label={label}
    >
      <span
        className={`flex h-14 w-14 items-center justify-center rounded-full border-2 shadow-glow transition-transform duration-150 active:scale-95 ${
          active ? 'border-lime bg-lime text-ink' : 'border-[#3a322a] bg-lime text-ink'
        }`}
      >
        <SwapIcon />
      </span>
      <span
        className={`mt-1 font-sans text-[11px] font-semibold tracking-wide ${
          active ? 'text-lime' : 'text-muted'
        }`}
      >
        {label}
      </span>
    </Link>
  );
}

/** Desktop horizontal tabs. */
export function AppDesktopTabs() {
  const pathname = usePathname() || '';
  const { t } = useLocale();
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-border pb-3" aria-label="App sections">
      {[...LEFT_TABS, ...RIGHT_TABS].map((tab) => {
        const active = tab.match(pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`rounded-md px-3 py-2 font-sans text-sm no-underline transition-colors ${
              active ? 'bg-lime/10 text-lime' : 'text-muted hover:bg-surface hover:text-paper'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            {t(tab.labelKey)}
          </Link>
        );
      })}
      <SwapPill />
    </nav>
  );
}

/** Mobile fixed bottom bar: Home | Wallet | large Swap | History | Account */
export function AppBottomNav() {
  const pathname = usePathname() || '';
  const { t } = useLocale();
  return (
    <nav
      className="app-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t border-border bg-ink/95 backdrop-blur-md md:hidden"
      aria-label="App"
    >
      <div className="mx-auto flex max-w-lg items-end justify-between px-1 pb-[env(safe-area-inset-bottom)] pt-1">
        {LEFT_TABS.map((tab) => (
          <CompactTab
            key={tab.href}
            href={tab.href}
            label={t(tab.labelKey)}
            active={tab.match(pathname)}
            Icon={tab.icon}
          />
        ))}
        <SwapPill compact />
        {RIGHT_TABS.map((tab) => (
          <CompactTab
            key={tab.href}
            href={tab.href}
            label={t(tab.labelKey)}
            active={tab.match(pathname)}
            Icon={tab.icon}
          />
        ))}
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

function SwapIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 7h11l-2.5-2.5M17 17H6l2.5 2.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18 7v4M6 13v4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
