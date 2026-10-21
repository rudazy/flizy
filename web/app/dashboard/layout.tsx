import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DashboardProvider } from '../../components/DashboardProvider';
import { DashboardGate } from '../../components/DashboardGate';
import { ExternalWalletProvider } from '../../components/ExternalWalletProvider';
import { AppBackgroundSync } from '../../components/AppBackgroundSync';
import { pageMetadata } from '../../lib/seo';
import { APPEARANCE_BOOT_SCRIPT } from '../../lib/appearanceCache';

/**
 * Private app surface. noindex rather than a robots.txt block, so Google can
 * read the directive and drop the URL instead of indexing it from inbound links
 * alone — /dashboard is linked from the header, footer and homepage.
 */
export const metadata: Metadata = pageMetadata({
  title: 'Dashboard | Flizy',
  description: 'Your Flizy wallet, trusted people, unlock PIN, and chat link codes.',
  path: '/dashboard',
  noindex: true,
});

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/*
        Fixed layer behind the app. A sibling of the shell, never a wrapper,
        so a filter here cannot become the containing block for the bottom nav.
      */}
      <div id="flizy-app-bg" className="app-bg" aria-hidden="true" />
      <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOT_SCRIPT }} />
      <Suspense fallback={<p className="text-muted">Loading dashboard...</p>}>
        <ExternalWalletProvider>
          <DashboardProvider>
            <AppBackgroundSync />
            <DashboardGate>{children}</DashboardGate>
          </DashboardProvider>
        </ExternalWalletProvider>
      </Suspense>
    </>
  );
}
