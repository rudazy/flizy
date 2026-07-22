import { Suspense } from 'react';
import { DashboardProvider } from '../../components/DashboardProvider';
import { DashboardGate } from '../../components/DashboardGate';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<p className="text-muted">Loading dashboard...</p>}>
      <DashboardProvider>
        <DashboardGate>{children}</DashboardGate>
      </DashboardProvider>
    </Suspense>
  );
}
