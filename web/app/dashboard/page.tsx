'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../components/AppTopBar';
import { useDashboard } from '../../components/DashboardProvider';
import { shortAddr } from '../../lib/dashboardTypes';

export default function DashboardHomePage() {
  const search = useSearchParams();
  const welcome = search.get('welcome') === '1';
  const { data, holdings, generateLink, busy, refreshing, refreshAll } = useDashboard();

  const checklist = useMemo(() => {
    if (!data) return [];
    return [
      { done: true, title: 'Account created', body: data.account.email || 'Signed in' },
      {
        done: Boolean(data.account.agent_wallet_address),
        title: 'Agent wallet ready',
        body: data.account.agent_wallet_address
          ? shortAddr(data.account.agent_wallet_address)
          : 'Generating...',
      },
      {
        done: data.trusted.length > 0,
        title: 'Trusted wallet added',
        body: data.trusted.length ? `${data.trusted.length} saved` : 'Required for sends',
        href: '/dashboard/account',
      },
      {
        done: data.account.has_pin,
        title: 'Unlock PIN',
        body: data.account.has_pin ? 'Set' : 'Recommended',
        href: '/dashboard/account',
      },
      {
        done: Boolean(data.link),
        title: 'WhatsApp link code',
        body: data.link ? `Code ${data.link.code}` : 'Generate when ready',
        href: '/dashboard/account',
      },
    ];
  }, [data]);

  if (!data) return null;

  const nativeBal = holdings?.holdings?.native;
  const credit = data.account.balance_eth ?? 0;

  return (
    <div className="space-y-5">
      <AppTopBar
        title="Flizy"
        actionLabel={refreshing ? '...' : 'Refresh'}
        onAction={refreshAll}
        actionBusy={refreshing}
      />

      {welcome ? (
        <div className="alert alert-ok">
          Welcome. Add a trusted wallet, set a PIN if you want, then link WhatsApp.
        </div>
      ) : null}

      <section className="hero-grid relative rounded-md border border-border bg-surface/40 px-4 py-6 sm:px-6">
        <p className="badge badge-gold mb-4">Your control room</p>
        <h2 className="font-sans text-2xl font-semibold tracking-wide text-paper sm:text-3xl">
          Send crypto on WhatsApp.
          <span className="mt-1 block bg-gradient-to-r from-[#e8c45a] to-[#c4893f] bg-clip-text text-transparent">
            Only to people you trust.
          </span>
        </h2>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
          Manage wallet, trusted names, and history here. Swap FLZ on the big Swap tab or on WhatsApp.
        </p>

        <div className="mt-4">
          <Link href="/dashboard/swap" className="btn btn-primary w-full py-3.5 text-base font-semibold no-underline">
            Open Swap
          </Link>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-md border border-border bg-ink/70 p-3">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted">On-chain</p>
            <p className="mt-1 font-sans text-lg text-lime">
              {nativeBal
                ? `${Number(nativeBal.balance).toFixed(4)} ${nativeBal.symbol}`
                : '— ETH'}
            </p>
          </div>
          <div className="rounded-md border border-border bg-ink/70 p-3">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted">Credit</p>
            <p className="mt-1 font-sans text-lg text-paper">{credit}</p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <Link href="/dashboard/wallet" className="btn btn-primary text-sm no-underline">
            Open wallet
          </Link>
          <button
            type="button"
            className="btn btn-ghost text-sm"
            onClick={generateLink}
            disabled={busy === 'link'}
          >
            {busy === 'link' ? 'Generating...' : 'Link WhatsApp'}
          </button>
          <Link href="/dashboard/account" className="btn btn-ghost text-sm no-underline">
            Trusted people
          </Link>
          <Link href="/dashboard/history" className="btn btn-ghost text-sm no-underline">
            History
          </Link>
        </div>
      </section>

      <section className="space-y-3">
        {[
          {
            t: 'For you',
            d: 'Fund your agent wallet, add trusted names, link WhatsApp once.',
            href: '/dashboard/wallet',
          },
          {
            t: 'For friends',
            d: 'They receive on addresses you already saved. No surprise drains.',
            href: '/dashboard/account',
          },
          {
            t: 'On WhatsApp',
            d: 'flizy me · flizy send · confirm. Same wallet as this app.',
            href: '/how-it-works',
          },
        ].map((card) => (
          <Link
            key={card.t}
            href={card.href}
            className="card card-hover flex items-start gap-3 p-4 no-underline"
          >
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-ink text-lime">
              <span className="font-sans text-xs">{card.t[0]}</span>
            </span>
            <div>
              <p className="font-sans text-sm tracking-wide text-paper">{card.t}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{card.d}</p>
            </div>
          </Link>
        ))}
      </section>

      <section className="card p-4">
        <p className="text-xs uppercase tracking-[0.14em] text-gold">Setup</p>
        <ul className="mt-3 space-y-3">
          {checklist.map((item) => (
            <li
              key={item.title}
              className="flex items-start gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <span className={item.done ? 'step-check' : 'text-muted'}>
                {item.done ? '[x]' : '[ ]'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-paper">{item.title}</p>
                <p className="text-xs text-muted">{item.body}</p>
              </div>
              {'href' in item && item.href && !item.done ? (
                <Link href={item.href} className="text-xs text-lime no-underline hover:text-gold">
                  Fix
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
