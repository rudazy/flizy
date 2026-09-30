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

/*
 * History is not in the bar: it is a Wallet slide rendering the same
 * ActivityPanels, so a tab for it would occupy a slot twice. /dashboard/history
 * stays a live route because links to it are already out there.
 *
 * Explore takes the slot rather than becoming a sixth tab. At 360px a sixth item
 * leaves about 52px per tab around the Swap pill, under the 44px tap target once
 * padding is counted, and the bar is the one piece of chrome on every screen.
 */
const RIGHT_TABS: Array<{
  href: string;
  labelKey: MessageKey;
  match: (p: string) => boolean;
  icon: (p: { active: boolean }) => JSX.Element;
}> = [
  {
    href: '/dashboard/explore',
    labelKey: 'nav.explore',
    match: (p: string) => p.startsWith('/dashboard/explore'),
    icon: ExploreIcon,
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
      className={`flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-start gap-[3px] px-0.5 pt-[10px] no-underline transition-colors ${
        active ? 'text-sun' : 'text-[#cfcfcf] hover:text-white'
      }`}
      aria-current={active ? 'page' : undefined}
    >
      <Icon active={active} />
      <span className={`font-sans text-[9.5px] tracking-wide ${active ? 'font-semibold' : 'font-medium'}`}>
        {label}
      </span>
      <span
        className={`mt-px h-[2px] w-[19px] rounded-full ${active ? 'bg-sun' : 'bg-transparent'}`}
        aria-hidden
      />
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
      className="relative -mt-[15px] flex min-w-[72px] flex-col items-center justify-start self-start no-underline"
      aria-current={active ? 'page' : undefined}
      aria-label={label}
    >
      <span
        className={`flex h-[47px] w-[47px] items-center justify-center rounded-full border-2 text-sun-ink transition-transform duration-150 active:scale-95 ${
          active ? 'border-sun' : 'border-[#3d381f]'
        }`}
        style={{
          background: 'linear-gradient(180deg, #f9d95d 0%, #f7d043 100%)',
          boxShadow: '0 6px 18px rgba(247, 208, 71, 0.22)',
        }}
      >
        <SwapIcon />
      </span>
      <span
        className={`mt-[2px] font-sans text-[9.5px] font-medium tracking-wide ${
          active ? 'text-sun' : 'text-[#cfcfcf]'
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

/** Mobile fixed bottom bar: Home | Wallet | large Swap | Explore | Account */
export function AppBottomNav() {
  const pathname = usePathname() || '';
  const { t } = useLocale();
  return (
    <nav
      className="app-bottom-nav fixed inset-x-0 bottom-0 z-50 border-t border-[#1c1e22] bg-[#0b0c0d]/95 backdrop-blur-md md:hidden"
      aria-label="App"
    >
      {/*
        Row height comes from --app-nav-row so the clearance token stays true.
        The safe-area inset lives on .app-bottom-nav only -- do not add it here.
      */}
      <div className="app-bottom-nav-row mx-auto flex max-w-lg items-start justify-between px-1">
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
        strokeWidth={active ? 2 : 1.7}
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
        strokeWidth={active ? 2 : 1.7}
      />
      <path d="M3 10h18" stroke="currentColor" strokeWidth={active ? 2 : 1.7} />
      <circle cx="16.5" cy="14.5" r="1.25" fill="currentColor" />
    </svg>
  );
}

function ExploreIcon({ active }: { active: boolean }) {
  // A compass: discovery rather than a magnifier, which would read as search.
  // Active is a solid disc with the needle cut out in the bar colour.
  if (active) {
    return (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="9.5" fill="currentColor" />
        <path d="M15.6 8.4l-2.2 5-5 2.2 2.2-5 5-2.2z" fill="#0b0c0d" />
      </svg>
    );
  }
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.8" stroke="currentColor" strokeWidth={1.7} />
      <path
        d="M15.2 8.8l-2 4.4-4.4 2 2-4.4 4.4-2z"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AccountIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="9" r="3.5" stroke="currentColor" strokeWidth={active ? 2 : 1.7} />
      <path
        d="M5 19.5c1.5-3 4-4.5 7-4.5s5.5 1.5 7 4.5"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.7}
        strokeLinecap="round"
      />
    </svg>
  );
}

function SwapIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
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
