'use client';

import { AppTopBar } from '../../../components/AppTopBar';
import { AppPage } from '../../../components/AppSection';
import { ActivityPanels } from '../../../components/ActivityPanels';
import { useDashboard } from '../../../components/DashboardProvider';

/**
 * History as its own tab.
 *
 * The panels live in components/ActivityPanels.tsx because Wallet renders the
 * same pair under its History slide. This page is the tab wrapper: a title, a
 * refresh, and the shared content.
 *
 * The product lock of 2026-09-17 takes History out of the bottom bar and leaves
 * it as a Wallet slide. This route stays regardless — links to /dashboard/history
 * are already out there, and the bar is a separate change that has not been made.
 */
export default function HistoryPage() {
  const { refreshing, refreshAll } = useDashboard();

  return (
    <AppPage>
      <AppTopBar
        title="History"
        actionLabel="Refresh"
        onAction={refreshAll}
        actionBusy={refreshing}
      />
      <ActivityPanels />
    </AppPage>
  );
}
