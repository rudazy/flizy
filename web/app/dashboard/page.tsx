'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../components/AppTopBar';
import {
  AppListRow,
  AppPage,
  AppQuickActions,
  AppSection,
  AppSlideNav,
  AppStatusCell,
  AppStatusStrip,
  useSlide,
} from '../../components/AppSection';
import { useDashboard } from '../../components/DashboardProvider';
import { useLocale } from '../../components/LocaleProvider';
import { shortAddr } from '../../lib/dashboardTypes';
import { CopyButton } from '../../components/CopyButton';

const SLIDES = ['overview', 'claims', 'go', 'recent'] as const;

export default function DashboardHomePage() {
  const search = useSearchParams();
  const { t } = useLocale();
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
    setAttachInviteOnClaims,
    setMsg,
  } = useDashboard();
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinPassword, setPinPassword] = useState('');
  const [githubLinkedNotice, setGithubLinkedNotice] = useState(false);
  const [claimBusyId, setClaimBusyId] = useState('');
  const [claimMsg, setClaimMsg] = useState('');

  const pendingClaims = data?.pendingClaims || [];
  const needsPin = data ? !data.account.has_pin : false;

  // Default to claims slide when there is money waiting, else overview.
  const defaultSlide = useMemo(() => {
    if (pendingClaims.length > 0) return 'claims';
    if (needsPin) return 'overview';
    return 'overview';
  }, [pendingClaims.length, needsPin]);

  const [slide, setSlide] = useSlide(SLIDES, defaultSlide);

  useEffect(() => {
    if (search.get('github') !== 'linked') return;
    setGithubLinkedNotice(true);
    if (pendingClaims.length > 0) setSlide('claims');
    const params = new URLSearchParams(window.location.search);
    params.delete('github');
    // Keep s= if present
    const rest = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
  }, [search, pendingClaims.length, setSlide]);

  const checklist = useMemo(() => {
    if (!data) return [];
    return [
      {
        done: Boolean(data.account.has_pin),
        title: 'Unlock PIN',
        body: data.account.has_pin ? 'Set' : 'Required for flizy unlock after lock',
        href: '/dashboard/account?s=pin',
      },
      {
        done: data.trusted.length > 0,
        title: 'Trusted wallet',
        body: data.trusted.length ? `${data.trusted.length} saved` : 'Required for named sends',
        href: '/dashboard/account?s=trusted',
      },
      {
        done: Boolean(data.link),
        title: 'Chat app',
        body: data.link ? 'Code ready to link' : 'Generate code on Account',
        href: '/dashboard/account?s=chat',
      },
    ];
  }, [data]);

  if (!data) return null;

  const nativeBal = holdings?.holdings?.native;
  const credit = data.account.balance_eth ?? 0;
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

  async function onClaimOne(claimId: string) {
    setClaimBusyId(claimId);
    setClaimMsg('');
    try {
      const res = await fetch('/api/claim/payout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setClaimMsg(json.error || 'Could not claim.');
        return;
      }
      setClaimMsg('Claim received. Funds are in your wallet.');
      await refreshAll();
      setSlide('claims');
    } catch {
      setClaimMsg('Could not claim. Try again.');
    } finally {
      setClaimBusyId('');
    }
  }

  const nav = [
    {
      id: 'overview',
      label: t('home.overview'),
      badge: openSetup.length ? String(openSetup.length) : undefined,
    },
    {
      id: 'claims',
      label: t('home.claims'),
      badge: pendingClaims.length ? String(pendingClaims.length) : undefined,
    },
    { id: 'go', label: t('home.go') },
    {
      id: 'recent',
      label: t('home.recent'),
      badge: recent.length ? String(recent.length) : undefined,
    },
  ];

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

      {githubLinkedNotice ? (
        <div className="alert alert-ok text-sm">
          GitHub linked. Check the Claims slide — receive holds with{' '}
          <span className="font-mono text-paper">flizy claim</span> in chat.
        </div>
      ) : null}

      {/* Status always visible — summary, not a buried section */}
      <AppStatusStrip>
        <AppStatusCell
          label="On-chain"
          value={
            nativeBal
              ? `${Number(nativeBal.balance).toFixed(4)} ${nativeBal.symbol}`
              : '— ETH'
          }
          href="/dashboard/wallet?s=balances"
        />
        <AppStatusCell label="Credit" value={String(credit)} href="/dashboard/wallet?s=balances" />
        <AppStatusCell
          label="Trusted"
          value={String(data.trusted.length)}
          href="/dashboard/account?s=trusted"
        />
        <AppStatusCell
          label="Wallet"
          value={
            data.account.agent_wallet_address
              ? shortAddr(data.account.agent_wallet_address)
              : '…'
          }
          href="/dashboard/wallet?s=balances"
        />
      </AppStatusStrip>

      <AppSlideNav items={nav} activeId={slide} onSelect={setSlide} />

      {slide === 'overview' ? (
        <>
          {data.invite ? (
            <AppSection title="Invite">
              <p className="break-all font-mono text-sm text-paper">{data.invite.url}</p>
              <div className="mt-3">
                <CopyButton value={data.invite.url} label="Copy link" />
              </div>
              <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={Boolean(data.invite.attachOnClaims)}
                  disabled={busy === 'invite-attach'}
                  onChange={(e) => {
                    void setAttachInviteOnClaims(e.target.checked);
                  }}
                />
                Attach to claims I send
              </label>
            </AppSection>
          ) : null}

          {needsPin ? (
            <AppSection
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
            <AppSection
              title="Needs attention"
              helper="Finish these so chat money works. Each opens its own Account slide."
              badge={`${openSetup.length}`}
            >
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

          {!needsPin && openSetup.length === 0 ? (
            <AppSection
              title="Overview"
              helper="Nothing blocking you. Use Go for destinations, Claims for held money."
              badge="Ready"
              badgeTone="lime"
            >
              <p className="text-sm text-muted">
                Chat for send / claim / pay. This desk is status and short lists only.
              </p>
              {data.link ? (
                <p className="mt-3 font-mono text-sm text-lime">Link code ready: {data.link.code}</p>
              ) : null}
              <button
                type="button"
                className="btn btn-ghost mt-4 w-full text-sm"
                onClick={() => setSlide('go')}
              >
                Open Go →
              </button>
            </AppSection>
          ) : null}
        </>
      ) : null}

      {slide === 'claims' ? (
        <AppSection
          title="Pending claims"
          helper="Phone holds: claim in WhatsApp/Telegram only. Email and platform holds: claim here or in chat."
          badge={pendingClaims.length ? String(pendingClaims.length) : '0'}
          badgeTone={pendingClaims.length ? 'gold' : 'default'}
        >
          {claimMsg ? (
            <div
              className={`mb-3 alert text-sm ${
                claimMsg.includes('received') ? 'alert-ok' : 'alert-error'
              }`}
            >
              {claimMsg}
            </div>
          ) : null}
          {pendingClaims.length === 0 ? (
            <p className="text-xs text-muted">
              No pending claims for you. Holds show here when someone sends to your registration
              email, a verified secondary email, GitHub/Discord/X/Telegram once linked, or a phone
              proven on chat.
            </p>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {pendingClaims.map((c) => {
                  const phoneOnly = c.kind === 'phone' || c.canClaimOnWeb === false;
                  const kindLine =
                    c.kind === 'email'
                      ? 'email · claim here or in chat'
                      : phoneOnly
                        ? 'phone · claim in WhatsApp or Telegram'
                        : 'platform · claim here or in chat';
                  return (
                    <li
                      key={c.id}
                      className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-sans text-sm text-paper">
                          {c.counterparty || c.label}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] uppercase text-muted">
                          {kindLine}
                        </p>
                        <p className="mt-1 font-sans text-sm text-lime">
                          +
                          {Number(c.amountEth).toLocaleString(undefined, {
                            maximumFractionDigits: 6,
                          })}{' '}
                          ETH
                        </p>
                      </div>
                      {phoneOnly ? (
                        <p className="shrink-0 text-xs text-muted sm:max-w-[9rem] sm:text-right">
                          Open bot →{' '}
                          <span className="font-mono text-paper">flizy claim</span>
                        </p>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary shrink-0 py-2.5 text-sm font-semibold sm:min-w-[7rem]"
                          disabled={Boolean(claimBusyId)}
                          onClick={() => void onClaimOne(c.id)}
                        >
                          {claimBusyId === c.id ? 'Claiming…' : 'Claim'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-xs text-muted">
                Phone money only moves after the number is proven in that chat app.
              </p>
            </>
          )}
        </AppSection>
      ) : null}

      {slide === 'go' ? (
        <AppSection title="Go" helper="Each tile opens that section as its own slide — not a scroll target.">
          <AppQuickActions
            items={[
              {
                href: '/dashboard?s=claims',
                label: 'Claims',
                hint: pendingClaims.length ? `${pendingClaims.length} held` : 'None',
              },
              { href: '/dashboard/account?s=chat', label: 'Link chat', hint: 'WA / TG' },
              { href: '/dashboard/account?s=platforms', label: 'Platforms', hint: 'GitHub…' },
              {
                href: '/dashboard/account?s=profile',
                label: 'Username',
                hint: data.account.username ? `@${data.account.username}` : 'Set',
              },
              { href: '/dashboard/wallet?s=fund', label: 'Fund', hint: 'Deposit' },
              { href: '/dashboard/history', label: 'History', hint: 'Activity' },
              { href: '/dashboard/swap', label: 'Swap', hint: 'FLZ' },
              { href: '/dashboard/account?s=pin', label: 'PIN', hint: 'Lock' },
            ]}
          />
          <div className="mt-4 border-t border-border pt-4">
            <p className="label">Chat link (short)</p>
            <button
              type="button"
              className="btn btn-primary mt-2 w-full py-3 font-semibold"
              onClick={() => generateLink()}
              disabled={busy === 'link'}
            >
              {busy === 'link'
                ? 'Working…'
                : data.link
                  ? 'New code'
                  : 'Generate link code'}
            </button>
            {data.link ? (
              <p className="mt-2 font-mono text-sm text-lime">{data.link.code}</p>
            ) : null}
            <Link
              href="/dashboard/account?s=chat"
              className="mt-2 inline-block text-xs text-lime no-underline hover:text-gold"
            >
              Full chat link options →
            </Link>
          </div>
        </AppSection>
      ) : null}

      {slide === 'recent' ? (
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
                <li
                  key={row.id}
                  className="flex items-start justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-sans text-sm text-paper">{row.label}</p>
                    <p className="mt-0.5 font-mono text-[10px] uppercase text-muted">
                      {row.status}
                    </p>
                  </div>
                  <p
                    className={`shrink-0 font-sans text-sm ${
                      row.direction === 'in' ? 'text-lime' : 'text-paper'
                    }`}
                  >
                    {row.direction === 'in' ? '+' : '−'}
                    {Number(row.amount).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })}{' '}
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
      ) : null}
    </AppPage>
  );
}
