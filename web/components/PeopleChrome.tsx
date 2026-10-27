'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppBottomNav, AppDesktopTabs } from './AppBottomNav';
import { PwaRegister } from './PwaRegister';

/**
 * The People surface. Same shell as the signed-in app: mark, bottom nav,
 * and the desktop section tabs. No marketing header and no site footer.
 * Privacy and Terms stay linked. A reader can open it without an account.
 * Follow still asks them to sign in.
 */
export function PeopleChrome({ children, signedIn }: { children: ReactNode; signedIn: boolean }) {
  const pathname = usePathname() || '';
  const onPeople = pathname === '/people' || pathname.startsWith('/u/');
  const enterHref = signedIn ? '/dashboard' : '/login?next=%2Fdashboard';

  return (
    <>
      <div id="flizy-app-bg" className="app-bg" aria-hidden="true" />
      <div className="app-shell app-shell-tabbed">
        <div className="fade-up mx-auto flex w-full max-w-lg flex-1 flex-col px-4 sm:max-w-[1200px] sm:px-6 md:py-8">
          <header className="sticky top-0 z-40 -mx-4 mb-4 bg-[#0b0a09]/90 px-4 pb-3 pt-[max(0.7rem,env(safe-area-inset-top))] backdrop-blur-md sm:-mx-6 sm:px-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Link
                  href={enterHref}
                  className="hit-44 flex h-[33px] w-[33px] shrink-0 items-center justify-center rounded-[7px] border border-[#3a3424] bg-[#111010] font-sans text-[18px] font-bold text-[#f7d047] no-underline"
                  aria-label="Flizy home"
                >
                  F
                </Link>
                <span className="font-sans text-[15px] font-semibold tracking-[0.18em] text-[#f5f5f5]">FLIZY</span>
              </div>
              <Link
                href={enterHref}
                className="inline-flex h-11 min-w-[72px] items-center justify-center rounded-[8px] bg-[#f7d047] px-4 font-sans text-[14px] font-semibold text-[#1a1405] no-underline shadow-[0_8px_20px_rgba(247,208,71,0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f7d047]"
              >
                App
              </Link>
            </div>
            <div className="mt-3 flex items-center gap-4">
              <Link
                href="/people"
                className={`inline-flex h-11 items-center border-b-2 font-sans text-[15px] font-semibold no-underline ${
                  onPeople ? 'border-[#f7d047] text-[#f7d047]' : 'border-transparent text-[#9d9d9d]'
                }`}
                aria-current={onPeople ? 'page' : undefined}
              >
                People
              </Link>
              <Link
                href={enterHref}
                className="inline-flex h-11 items-center border-b-2 border-transparent font-sans text-[15px] font-medium text-[#9d9d9d] no-underline"
              >
                Home
              </Link>
              {pathname.startsWith('/u/') ? (
                <form action="/people" method="get" className="ml-auto w-full min-w-0 max-w-[240px] flex-1 md:max-w-xs">
                  <label className="relative block">
                    <span className="sr-only">Search users</span>
                    <SearchGlyph />
                    <input
                      name="q"
                      placeholder="Search users..."
                      autoComplete="off"
                      maxLength={24}
                      className="h-11 w-full rounded-full border border-[#2a2b30] bg-[#14120e] pl-10 pr-3 font-sans text-[14px] text-white outline-none placeholder:text-[#6f6a62] focus:border-[#f7d047]"
                    />
                  </label>
                </form>
              ) : null}
            </div>
            <div className="mt-2 hidden md:block">
              <AppDesktopTabs />
            </div>
          </header>
          {children}
          <nav aria-label="Legal" className="mt-8 flex gap-4">
            <Link
              href="/privacy"
              className="inline-flex min-h-[44px] items-center font-sans text-[12px] text-[#c8c2b8] no-underline"
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              className="inline-flex min-h-[44px] items-center font-sans text-[12px] text-[#c8c2b8] no-underline"
            >
              Terms
            </Link>
          </nav>
        </div>
        <AppBottomNav />
        <PwaRegister />
      </div>
    </>
  );
}

function SearchGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#8d867c]"
    >
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M16 16.5L20 20.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
