'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';
import { PwaRegister } from './PwaRegister';

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() || '';
  const isApp = pathname.startsWith('/dashboard');

  if (isApp) {
    // App routes: own top bar + bottom nav; no marketing chrome.
    // Vertical padding starts at md, matching where .app-shell stops owning
    // 100dvh -- at sm it would add height the shell has not accounted for and
    // push the page into a short scroll.
    return (
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-0 sm:max-w-[1200px] sm:px-6 md:py-8">
        {children}
      </main>
    );
  }

  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[1200px] flex-1 px-6 py-12 md:py-16">{children}</main>
      <SiteFooter />
      <PwaRegister />
    </>
  );
}
