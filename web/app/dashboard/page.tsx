'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../components/AppTopBar';
import {
  AppListRow,
  AppPage,
  AppQuickActions,
  AppSection,
  AppStatusCell,
  AppStatusStrip,
} from '../../components/AppSection';
import { useDashboard } from '../../components/DashboardProvider';
import { shortAddr } from '../../lib/dashboardTypes';

export default function DashboardHomePage() {
  const search = useSearchParams();
  const welcome = search.get('welcome') === '1';
  const {
    data,
    holdings,
    activity,
    generateLink,
    busy,
    refreshing,
    refreshAll,
    setUnlockPin,
    setMsg,
  } = useDashboard();
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinPassword, setPinPassword] = useState('');

  const checklist = useMemo(() => {
    if (!data) return [];
    return [
      {
        done: Boolean(data.account.has_pin),
        title: 'Unlock PIN',
        body: data.account.has_pin ? 'Set' : 'Required for flizy unlock after lock',
        href: '/dashboard/account#pin',
      },
      {
        done: data.trusted.length > 0,
        title: 'Trusted wallet',
        body: data.trusted.length ? `${data.trusted.length} saved` : 'Required for named sends',
        href: '/dashboard/account#trusted',
      },
      {
        done: Boolean(data.link),
        title: 'Chat app',
        body: data.link ? 'Code ready to link' : 'Generate code on Account',
        href: '/dashboard/account#chat',
      },
    ];
  }, [data]);

  if (!data) return null;

  const nativeBal = holdings?.holdings?.native;
  const credit = data.account.balance_eth ?? 0;
  const needsPin = !data.account.has_pin;
  const openSetup = checklist.filter((c) => !c.done);
  const recent = (activity || []).slice(0, 5);

  async function onQuickPin(e: React.FormEvent) {
    e.preventDefault();
    if (pin !== pin2) {
      setMsg('PINs do not match.');
      return;
    }
    if (!/^\d{4,12}$/.test(pin)) {
      setMsg('PIN must be 4-12 digits.');
      return;
    }
    const ok = await setUnlockPin(pin, pinPassword);
    if (ok) {
      setPin('');
      setPin2('');
      setPinPassword('');
    }
  }

  return (
    <AppPage>
      <AppTopBar
        title="Home"
        actionLabel={refreshing ? '...' : 'Refresh'}
        onAction={refreshAll}
        actionBusy={refreshing}
      />

      {welcome ? (
        <div className="alert alert-ok text-sm">
          Welcome. Set your unlock PIN, then connect WhatsApp or Telegram from Account.
        </div>
      ) : null}

      {/* Status strip — always visible, no scroll hunt */}
      <AppStatusStrip>
        <AppStatusCell
          label="On-chain"
          value={
            nativeBal
              ? `${Number(nativeBal.balance).toFixed(4)} ${nativeBal.symbol}`
              : '— ETH'
          }
          href="/dashboard/wallet"
        />
        <AppStatusCell label="Credit" value={String(credit)} href="/dashboard/wallet" />
        <AppStatusCell
          label="Trusted"
          value={String(data.trusted.length)}
          href="/dashboard/account#trusted"
        />
        <AppStatusCell
          label="Wallet"
          value={
            data.account.agent_wallet_address
              ? shortAddr(data.account.agent_wallet_address)
              : '…'
          }
          href="/dashboard/wallet"
        />
      </AppStatusStrip>

      {/* Needs attention — only incomplete / required */}
      {needsPin ? (
        <AppSection
          id="attention-pin"
          title="Set unlock PIN"
          helper="Required. After flizy lock, unlock with this PIN or your password."
          badge="Required"
          badgeTone="gold"
        >
          <form onSubmit={onQuickPin} className="grid gap-2 sm:grid-cols-2">
            <input
              className="input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              minLength={4}
              maxLength={12}
              placeholder="PIN (4-12 digits)"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              required
            />
            <input
              className="input"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              minLength={4}
              maxLength={12}
              placeholder="Confirm PIN"
              value={pin2}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
              required
            />
            <input
              className="input sm:col-span-2"
              type="password"
              autoComplete="current-password"
              placeholder="Your account password"
              value={pinPassword}
              onChange={(e) => setPinPassword(e.target.value)}
              required
            />
            <button
              type="submit"
              className="btn btn-primary w-full py-3 font-semibold sm:col-span-2"
              disabled={busy === 'pin'}
            >
              {busy === 'pin' ? 'Saving...' : 'Save unlock PIN'}
            </button>
          </form>
        </AppSection>
      ) : null}

      {openSetup.length > 0 && !needsPin ? (
        <AppSection title="Needs attention" helper="Finish these so chat money works." badge={`${openSetup.length}`}>
          <ul>
            {openSetup.map((item) => (
              <AppListRow
                key={item.title}
                title={item.title}
                body={item.body}
                done={item.done}
                href={item.href}
              />
            ))}
          </ul>
        </AppSection>
      ) : null}

      {/* Quick actions — fixed slots for future claims / platforms */}
      <AppSection title="Go" helper="Everything important has a home. No long scroll.">
        <AppQuickActions
          items={[
            { href: '/dashboard/account#chat', label: 'Link chat', hint: 'WA / TG' },
            { href: '/dashboard/account#platforms', label: 'Platforms', hint: 'GitHub…' },
            { href: '/dashboard/wallet', label: 'Fund', hint: 'Deposit' },
            { href: '/dashboard/history', label: 'History', hint: 'Activity' },
            { href: '/dashboard/swap', label: 'Swap', hint: 'FLZ' },
            { href: '/dashboard/account#trusted', label: 'Trusted', hint: 'Names' },
            { href: '/dashboard/account#pin', label: 'PIN', hint: 'Lock' },
            { href: '/dashboard/account#security', label: 'Account', hint: 'Sign out' },
          ]}
        />
      </AppSection>

      {/* Connect chat — short, full controls live on Account */}
      <AppSection
        id="connect"
        title="Connect a chat app"
        helper="One-time code. Same account on WhatsApp and Telegram."
        badge={data.link ? 'Ready' : 'Needed'}
        badgeTone={data.link ? 'lime' : 'gold'}
      >
        {data.link ? (
          <p className="mb-3 font-mono text-lg text-lime">{data.link.code}</p>
        ) : null}
        <button
          type="button"
          className="btn btn-primary w-full py-3 font-semibold"
          onClick={() => generateLink()}
          disabled={busy === 'link'}
        >
          {busy === 'link'
            ? 'Working…'
            : data.link
              ? 'New code & open WhatsApp'
              : 'Generate code & open WhatsApp'}
        </button>
        <div className="mt-2 flex flex-wrap gap-2">
          {data.link?.telegramDeepLink ? (
            <a
              href={data.link.telegramDeepLink}
              className="btn btn-ghost flex-1 text-sm no-underline"
              target="_blank"
              rel="noreferrer"
            >
              Open Telegram
            </a>
          ) : null}
          <Link href="/dashboard/account#chat" className="btn btn-ghost flex-1 text-sm no-underline">
            Full link options
          </Link>
        </div>
      </AppSection>

      {/* Recent — full list is History */}
      <AppSection
        title="Recent"
        helper="Latest money moves. Full list on History."
        badge={recent.length ? String(recent.length) : undefined}
      >
        {recent.length === 0 ? (
          <p className="text-xs text-muted">
            Nothing yet. After sends, claims, and swaps, they show here.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate font-sans text-sm text-paper">{row.label}</p>
                  <p className="mt-0.5 font-mono text-[10px] uppercase text-muted">{row.status}</p>
                </div>
                <p
                  className={`shrink-0 font-sans text-sm ${
                    row.direction === 'in' ? 'text-lime' : 'text-paper'
                  }`}
                >
                  {row.direction === 'in' ? '+' : '−'}
                  {Number(row.amount).toLocaleString(undefined, { maximumFractionDigits: 4 })}{' '}
                  {row.asset}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Link
          href="/dashboard/history"
          className="mt-3 inline-block text-xs text-lime no-underline hover:text-gold"
        >
          See all activity →
        </Link>
      </AppSection>

      {/* Fund teaser — full guide lives on Wallet */}
      <AppSection
        title="Fund"
        helper="Testnet ETH lands on your agent wallet. Full steps on Wallet."
      >
        {data.account.agent_wallet_address ? (
          <p className="break-all font-mono text-[11px] text-muted">
            {data.account.agent_wallet_address}
          </p>
        ) : (
          <p className="text-xs text-muted">Wallet generating…</p>
        )}
        <Link href="/dashboard/wallet#fund" className="btn btn-ghost mt-3 w-full text-sm no-underline">
          How to fund →
        </Link>
      </AppSection>
    </AppPage>
  );
}
