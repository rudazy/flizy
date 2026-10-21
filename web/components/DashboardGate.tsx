'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useDashboard } from './DashboardProvider';
import { AppBottomNav } from './AppBottomNav';
import { PwaRegister } from './PwaRegister';
import { EmailVerifyGate } from './EmailVerifyGate';
import { ProfileCompleteGate } from './ProfileCompleteGate';
import { useExternalWallet } from './ExternalWalletProvider';
import { ContinueWithWallet, NeedsAccount, WalletModeBar } from './WalletModeBits';
import { isWalletModePath } from '../lib/walletMode';

function hasUsername(data: { account?: { username?: string | null } }): boolean {
  const u = String(data.account?.username || '').trim();
  return u.length > 0;
}

export function DashboardGate({ children }: { children: ReactNode }) {
  const { data, error, msg, signedOut } = useDashboard();
  const wallet = useExternalWallet();
  const pathname = usePathname() || '/dashboard';
  const search = useSearchParams();
  const nextPath = `${pathname}${search.toString() ? `?${search.toString()}` : ''}`;
  const loginHref = `/login?next=${encodeURIComponent(nextPath.startsWith('/') ? nextPath : '/dashboard')}`;

  // Wallet mode: no Flizy session, but the visitor's own wallet is connected.
  // Only the pages lib/walletMode.ts names open; the rest say they need an account.
  if (signedOut && !data && wallet?.address) {
    if (!isWalletModePath(pathname)) return <NeedsAccount />;
    return (
      <div className="app-shell app-shell-tabbed">
        <div className="fade-up flex flex-1 flex-col">
          <WalletModeBar />
          {children}
        </div>
        <AppBottomNav />
        <PwaRegister />
      </div>
    );
  }
  // A wallet that may already be connected is still being checked: wait rather than flash the login.
  if (signedOut && !data && wallet && !wallet.ready && isWalletModePath(pathname)) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-sm text-muted">Checking your wallet...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="fade-up mx-auto max-w-md space-y-5 py-8">
        <h1 className="font-sans text-3xl tracking-wide text-paper">Dashboard</h1>
        <div className="alert alert-warn">{error}</div>
        <div className="flex gap-3">
          <Link href={loginHref} className="btn btn-primary">
            Log in
          </Link>
          <Link href="/signup" className="btn btn-ghost">
            Create account
          </Link>
        </div>
        {signedOut && isWalletModePath(pathname) ? (
          <div className="space-y-2 border-t border-[var(--border)] pt-4">
            <p className="text-sm text-muted">Or explore, swap and trade NFTs with your own wallet. No account needed.</p>
            <ContinueWithWallet next={nextPath} className="btn btn-ghost w-full" />
          </div>
        ) : null}
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
    <div className="app-shell app-shell-tabbed">
      {/*
        fade-up must stay OFF the shell. It animates transform, and with
        fill-mode both the final translateY(0) sticks around -- a transformed
        ancestor becomes the containing block for position:fixed descendants,
        which silently demotes the bottom nav to absolute against this element
        and lets it scroll away. Keep the entrance animation scoped to the
        content, never to an ancestor of the nav.
      */}
      <div className="fade-up flex flex-1 flex-col">
        {msg ? (
          <div className="alert alert-ok mb-4 text-sm" role="status">
            {msg}
          </div>
        ) : null}
        {children}
      </div>
      {/* After the content: the nav is fixed, so DOM order is free to follow
          reading order for screen readers and sequential focus. */}
      <AppBottomNav />
      <PwaRegister />
    </div>
  );
}
