'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useDashboard } from './DashboardProvider';
import { AppBottomNav } from './AppBottomNav';
import { PwaRegister } from './PwaRegister';
import { EmailVerifyGate } from './EmailVerifyGate';
import { ProfileCompleteGate } from './ProfileCompleteGate';

function hasUsername(data: { account?: { username?: string | null } }): boolean {
  const u = String(data.account?.username || '').trim();
  return u.length > 0;
}

export function DashboardGate({ children }: { children: ReactNode }) {
  const { data, error, msg } = useDashboard();

  if (error && !data) {
    return (
      <div className="fade-up mx-auto max-w-md space-y-5 py-8">
        <h1 className="font-sans text-3xl tracking-wide text-paper">Dashboard</h1>
        <div className="alert alert-warn">{error}</div>
        <div className="flex gap-3">
          <Link href="/login" className="btn btn-primary">
            Log in
          </Link>
          <Link href="/signup" className="btn btn-ghost">
            Create account
          </Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-muted">Loading your dashboard...</p>
      </div>
    );
  }

  // Stage 2: verify email before any features.
  if (!data.account.email_verified) {
    return (
      <div className="app-shell fade-up pb-8">
        {msg ? (
          <div className="alert alert-ok mb-4 text-sm" role="status">
            {msg}
          </div>
        ) : null}
        <EmailVerifyGate />
        <PwaRegister />
      </div>
    );
  }

  // Stage 3: username (+ optional display name) after email is verified.
  if (!hasUsername(data)) {
    return (
      <div className="app-shell fade-up pb-8">
        {msg ? (
          <div className="alert alert-ok mb-4 text-sm" role="status">
            {msg}
          </div>
        ) : null}
        <ProfileCompleteGate />
        <PwaRegister />
      </div>
    );
  }

  return (
    <div className="app-shell fade-up pb-24 md:pb-8">
      {msg ? (
        <div className="alert alert-ok mb-4 text-sm" role="status">
          {msg}
        </div>
      ) : null}
      <AppBottomNav />
      {children}
      <PwaRegister />
    </div>
  );
}
