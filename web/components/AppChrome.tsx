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
    // App routes: own top bar + bottom nav; no marketing chrome
    return (
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-0 sm:max-w-[1200px] sm:px-6 sm:py-8">
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
