import type { Metadata } from 'next';
import { Suspense } from 'react';
import { DashboardProvider } from '../../components/DashboardProvider';
import { DashboardGate } from '../../components/DashboardGate';
import { pageMetadata } from '../../lib/seo';

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
    <Suspense fallback={<p className="text-muted">Loading dashboard...</p>}>
      <DashboardProvider>
        <DashboardGate>{children}</DashboardGate>
      </DashboardProvider>
    </Suspense>
  );
}
