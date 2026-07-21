import { Suspense } from 'react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<p className="text-muted">Loading dashboard...</p>}>{children}</Suspense>;
}
