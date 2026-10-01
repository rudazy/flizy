'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../components/AppTopBar';
import { AppPage, AppSlideNav, useSlide, useTapGesture } from '../../components/AppSection';
import { AppCard, AppCardHeader, AppCollapsibleCard } from '../../components/AppCard';
import { useDashboard } from '../../components/DashboardProvider';
import { useLocale } from '../../components/LocaleProvider';
import { useComingSoon } from '../../components/ComingSoon';
import { shortAddr } from '../../lib/dashboardTypes';
import { CopyButton } from '../../components/CopyButton';
import { EyeMark } from '../../components/BalanceEye';
import { formatClaimAmount } from '../../lib/claimAmount.ts';
import { formatAmount } from '../../../lib/amountDisplay';
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  BoltIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  HistoryIcon,
  ListIcon,
  PeopleIcon,
  PersonIcon,
  PlusCircleIcon,
  SwapArrowsIcon,
  UserPlusIcon,
  WalletIcon,
} from '../../components/ExploreIcons';

const SLIDES = ['overview', 'claims', 'go', 'recent'] as const;

type TaskCounts = { live: number; review: number; completed: number; cancelled: number };

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
  const [comingSoon, comingSoonNote] = useComingSoon();
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [pinPassword, setPinPassword] = useState('');
  const [githubLinkedNotice, setGithubLinkedNotice] = useState(false);
  const [claimBusyId, setClaimBusyId] = useState('');
  const [claimMsg, setClaimMsg] = useState('');
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [walletFlash, setWalletFlash] = useState('');
  const [taskCounts, setTaskCounts] = useState<TaskCounts | null>(null);
  // Your tasks and Quick actions start closed; a tap on either header opens it.
  const [tasksOpen, setTasksOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  // Tasks this account has entered, by state. A failure leaves the card on
  // dashes rather than on zeros that would read as a real answer.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/tasks/mine');
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled && body?.counts) setTaskCounts(body.counts as TaskCounts);
      } catch {
        /* the card shows dashes */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingClaims = data?.pendingClaims || [];
  const needsPin = data ? !data.account.has_pin : false;

  // Default to claims slide when there is money waiting, else overview.
  const defaultSlide = useMemo(() => {
    if (pendingClaims.length > 0) return 'claims';
    return 'overview';
  }, [pendingClaims.length]);

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

  // One tap copies the full address. Two taps open the wallet.
  const onWalletTap = useTapGesture(
    () => void copyWallet(),
    () => router.push('/dashboard/wallet?s=balances')
  );

  if (!data) return null;

  const nativeBal = holdings?.holdings?.native;
  const chainName = holdings?.holdings?.chain?.name || 'GIWA Sepolia';
  const inviteCredit = data.invite?.credits ?? 0;
  const openSetup = checklist.filter((c) => !c.done);
  const recent = (activity || []).slice(0, 5);
  const walletAddress = data.account.agent_wallet_address || '';
  const walletValue =
    walletFlash === 'copied'
      ? 'Copied'
      : walletFlash === 'failed'
        ? 'Not copied'
        : walletAddress
          ? shortAddr(walletAddress)
          : '...';

  async function copyWallet() {
    if (!walletAddress) return;
    try {
      await navigator.clipboard.writeText(walletAddress);
      setWalletFlash('copied');
    } catch {
      setWalletFlash('failed');
    }
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setWalletFlash(''), 1600);
  }

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
      <AppTopBar title="Home" actionLabel="Refresh" onAction={refreshAll} actionBusy={refreshing} />

      {welcome ? (
        <div className="alert alert-ok text-sm">
          Welcome. Set your unlock PIN, then connect WhatsApp or Telegram from Account.
        </div>
      ) : null}

      {githubLinkedNotice ? (
        <div className="alert alert-ok text-sm">
          GitHub linked. Check the Claims slide. Receive holds with{' '}
          <span className="font-mono text-paper">flizy claim</span> in chat.
        </div>
      ) : null}

      <div className="!-mt-[14.5px] grid gap-[8.8px]">
        {/*
          The balance starts covered. Each tap of the eye switches between the
          figure and the mask. formatAmount rather than toFixed so this figure
          reads the same here as in chat, in history and on a receipt.
        */}
        <section
          className="relative h-[101px] overflow-hidden rounded-[6px] border border-[#4a3d1c]"
          style={{ background: 'linear-gradient(100deg, #0e0d0b 0%, #13110b 55%, #1a1508 100%)' }}
        >
          <HeroEmblem />
          <div className="relative px-[16.8px] pt-[17px]">
            <div className="flex items-center gap-[12px]">
              <span className="font-mono text-[9.2px] uppercase tracking-[0.12em] text-[#cfcfcf]">Total balance</span>
              <button
                type="button"
                onClick={() => setBalanceOpen((open) => !open)}
                aria-pressed={balanceOpen}
                aria-label={balanceOpen ? 'Hide balance' : 'Show balance'}
                className="hit-44 flex h-[14px] w-[16px] items-center justify-center text-[#ececec] hover:text-white"
              >
                <EyeMark hidden={!balanceOpen} className="h-[15px] w-[15px]" />
              </button>
            </div>
            <div className="mt-[9px] flex h-[26px] items-center gap-[13px]">
              {balanceOpen ? (
                <span className="font-sans text-[24px] font-semibold leading-none text-white">
                  {nativeBal ? formatAmount(nativeBal.balance) : '...'}
                </span>
              ) : (
                <span className="flex gap-[5.6px]" aria-label="Balance hidden">
                  {[0, 1, 2, 3].map((i) => (
                    <span key={i} className="h-[9.6px] w-[9.6px] rounded-full bg-white" />
                  ))}
                </span>
              )}
              <button
                type="button"
                onClick={() => comingSoon('Other assets')}
                aria-label="Show the total in another asset, coming soon"
                className="ml-[4px] flex items-center gap-[7px] text-[#ececec] hover:text-white"
              >
                <span className="font-sans text-[13px]">{nativeBal?.symbol || 'ETH'}</span>
                <ChevronDownIcon size={11} />
              </button>
            </div>
            <p className="m-0 mt-[11px] flex items-center gap-[6px] font-sans text-[9px] text-[#a9a9a9]">
              On {chainName}
              <span aria-hidden>{'\u00b7'}</span>
              <Link href="/dashboard/wallet?s=balances" className="text-[#e6e6e6] no-underline hover:text-white">
                View wallet
              </Link>
            </p>
          </div>
        </section>

        <div className="grid grid-cols-3 gap-[6px]">
          <StatTile
            href="/dashboard/account?s=trusted"
            icon={<PeopleIcon size={13} />}
            label="Trusted users"
            value={String(data.trusted.length)}
          />
          {/*
            Invites, not credit: data.invite.credits is earned invite credit,
            which CREDITS_SPENDABLE deliberately keeps unspendable. It must not
            read like money.
          */}
          <StatTile
            href="/dashboard/account?s=profile"
            icon={<UserPlusIcon size={13} />}
            label="Invites"
            value={String(inviteCredit)}
          />
          <button
            type="button"
            onClick={onWalletTap}
            aria-label={`Wallet address: ${walletValue}. ${
              walletFlash === 'copied' ? 'Wallet address copied.' : 'Tap to copy it. Double tap opens the wallet.'
            }`}
            className="flex h-[75px] touch-manipulation select-none flex-col rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[9px] pt-[8px] text-left"
          >
            <TileIcon>
              <WalletIcon size={13} />
            </TileIcon>
            <span className="mt-[7px] font-mono text-[7.6px] uppercase tracking-[0.1em] text-[#d0d0d0]">
              Wallet address
            </span>
            <span className="mt-[3px] flex w-full items-center justify-between gap-1">
              <span className="truncate font-sans text-[10.5px] font-semibold text-white">{walletValue}</span>
              <CopyIcon size={11} className="shrink-0 text-[#d9d9d9]" />
            </span>
          </button>
        </div>
      </div>

      <div className="!mt-[14px]">
        <AppSlideNav items={nav} activeId={slide} onSelect={setSlide} variant="pills" />
      </div>

      {slide === 'overview' ? (
        <div className="!mt-[13.5px] grid gap-[11.5px]">
          <AppCollapsibleCard
            id="home-tasks"
            icon={<ListIcon size={15} />}
            title="Your tasks"
            subtitle="Tasks you have entered on Explore."
            open={tasksOpen}
            onToggle={() => setTasksOpen((open) => !open)}
          >
            <div className="mt-[12.5px] grid grid-cols-4 border-t border-[#1f1f22] pt-[10px]">
              {(
                [
                  ['live', 'Active'],
                  ['completed', 'Completed'],
                  ['review', 'In review'],
                  ['cancelled', 'Cancelled'],
                ] as const
              ).map(([key, label], i) => (
                <div
                  key={key}
                  className={`flex flex-col items-center ${i ? 'border-l border-[#1f1f22]' : ''}`}
                >
                  <span className={`font-sans text-[13px] font-semibold ${key === 'live' ? 'text-sun' : 'text-white'}`}>
                    {taskCounts ? taskCounts[key] : '-'}
                  </span>
                  <span className={`mt-[3px] font-sans text-[8.6px] ${key === 'live' ? 'text-sun' : 'text-[#a9a9a9]'}`}>
                    {label}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-[11px] flex justify-end">
              <CardLink href="/dashboard/explore">View all</CardLink>
            </div>
          </AppCollapsibleCard>

          {needsPin ? (
            <AppCard className="px-[12px] pb-[12px] pt-[12.5px]">
              <AppCardHeader
                icon={<AlertCircleIcon size={15} />}
                title="Set unlock PIN"
                subtitle="Required. After flizy lock, unlock with this PIN."
                action={<Badge>Required</Badge>}
              />
              <form onSubmit={onQuickPin} className="mt-[11px] grid grid-cols-2 gap-[7px]">
                <input
                  className={FIELD}
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  minLength={4}
                  maxLength={12}
                  placeholder="PIN (4-12 digits)"
                  aria-label="PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  required
                />
                <input
                  className={FIELD}
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  minLength={4}
                  maxLength={12}
                  placeholder="Confirm PIN"
                  aria-label="Confirm PIN"
                  value={pin2}
                  onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
                  required
                />
                <input
                  className={`${FIELD} col-span-2`}
                  type="password"
                  autoComplete="current-password"
                  placeholder="Your account password"
                  aria-label="Your account password"
                  value={pinPassword}
                  onChange={(e) => setPinPassword(e.target.value)}
                  required
                />
                <button
                  type="submit"
                  className="btn-sun col-span-2 h-[31px] rounded-[4px] font-sans text-[10.5px]"
                  disabled={busy === 'pin'}
                >
                  {busy === 'pin' ? 'Saving...' : 'Save unlock PIN'}
                </button>
              </form>
            </AppCard>
          ) : null}

          {openSetup.length > 0 && !needsPin ? (
            <AppCard className="px-[12px] pb-[11px] pt-[12.5px]">
              <AppCardHeader
                icon={<AlertCircleIcon size={15} />}
                title="Needs attention"
                subtitle="Finish these to keep everything working smoothly."
                action={<Badge>{String(openSetup.length)}</Badge>}
              />
              <ul className="m-0 mt-[14.5px] grid list-none gap-[5px] p-0">
                {openSetup.map((item) => (
                  <li
                    key={item.title}
                    className="flex h-[47px] items-center gap-[12px] rounded-[5px] border border-[#1f1f22] bg-[#0f0f10] pl-[15.5px] pr-[7px]"
                  >
                    <span className="h-[17px] w-[17px] shrink-0 rounded-full border-[1.5px] border-[#5c5c60]" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-sans text-[10.5px] font-medium text-white">{item.title}</span>
                      <span className="block truncate font-sans text-[8.6px] text-[#a9a9a9]">{item.body}</span>
                    </span>
                    <Link
                      href={item.href}
                      className="btn-sun hit-y-44 h-[28px] shrink-0 rounded-[4px] px-[13px] font-sans text-[10px] no-underline"
                    >
                      Open
                    </Link>
                  </li>
                ))}
              </ul>
            </AppCard>
          ) : null}

          {!needsPin && openSetup.length === 0 ? (
            <AppCard className="px-[12px] pb-[12px] pt-[12.5px]">
              <AppCardHeader
                icon={<CheckIcon size={15} />}
                title="All set"
                subtitle="Nothing needs attention. Money moves in chat."
                action={<Badge>Ready</Badge>}
              />
              {data.link ? (
                <p className="m-0 mt-[10px] font-mono text-[9.5px] text-sun">Link code ready: {data.link.code}</p>
              ) : null}
            </AppCard>
          ) : null}

          {/* Receive only: sending happens in chat, not on the web. */}
          <AppCollapsibleCard
            id="home-actions"
            icon={<BoltIcon size={15} />}
            title="Quick actions"
            subtitle="Common things you might need."
            open={actionsOpen}
            onToggle={() => setActionsOpen((open) => !open)}
          >
            <div className="mt-[11px] grid grid-cols-2 gap-[5px]">
              <ActionRow href="/dashboard/wallet?s=fund" icon={<ArrowDownIcon size={13} />} label="Receive" />
              <ActionRow href="/dashboard/swap" icon={<SwapArrowsIcon size={13} />} label="Swap" />
              <ActionRow href="/dashboard/explore/new" icon={<PlusCircleIcon size={13} />} label="Create task" />
              <ActionRow href="/dashboard/account?s=profile" icon={<PersonIcon size={13} />} label="Profile" />
            </div>
          </AppCollapsibleCard>

          {data.invite ? (
            <AppCard className="px-[12px] pb-[12px] pt-[12.5px]">
              <AppCardHeader
                icon={<UserPlusIcon size={15} />}
                title="Invite"
                subtitle="Share your link. Invites you earn show above."
                action={<CopyButton value={data.invite.url} label="Copy link" className="!min-h-0 !px-[10px] !py-[6px] !font-sans !text-[9.6px]" />}
              />
              <p className="m-0 mt-[11px] break-all rounded-[4px] border border-[#2a2b30] bg-[#0b0b0c] px-[10px] py-[8px] font-mono text-[9px] text-[#e6e6e6]">
                {data.invite.url}
              </p>
              <label className="mt-[9px] flex cursor-pointer items-center gap-[8px] font-sans text-[9px] text-[#b5b5b5]">
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
            </AppCard>
          ) : null}
        </div>
      ) : null}

      {slide === 'claims' ? (
        <AppCard className="!mt-[13.5px] px-[12px] pb-[12px] pt-[12.5px]">
          <AppCardHeader
            icon={<ArrowDownIcon size={15} />}
            title="Pending claims"
            subtitle="Money held for you until you claim it."
            action={<Badge>{String(pendingClaims.length)}</Badge>}
          />
          {claimMsg ? (
            <div className={`mt-[10px] alert text-sm ${claimMsg.includes('received') ? 'alert-ok' : 'alert-error'}`}>
              {claimMsg}
            </div>
          ) : null}
          {pendingClaims.length === 0 ? (
            <p className="m-0 mt-[11px] font-sans text-[9px] leading-[13px] text-[#a9a9a9]">
              No pending claims for you. Holds show here when someone sends to your registration email, a verified
              secondary email, GitHub, Discord, X or Telegram once linked, or a phone proven on chat.
            </p>
          ) : (
            <>
              <ul className="m-0 mt-[11px] grid list-none gap-[5px] p-0">
                {pendingClaims.map((c) => {
                  const phoneOnly = c.kind === 'phone' || c.canClaimOnWeb === false;
                  const kindLine =
                    c.kind === 'email'
                      ? 'Email. Claim here or in chat'
                      : phoneOnly
                        ? 'Phone. Claim in WhatsApp or Telegram'
                        : 'Platform. Claim here or in chat';
                  return (
                    <li
                      key={c.id}
                      className="flex items-center gap-[10px] rounded-[5px] border border-[#1f1f22] bg-[#0f0f10] px-[11px] py-[9px]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-sans text-[10.5px] font-medium text-white">
                          {c.counterparty || c.label}
                        </span>
                        <span className="block font-sans text-[8.4px] text-[#a9a9a9]">{kindLine}</span>
                        <span className="mt-[2px] block font-sans text-[10px] font-semibold text-sun">
                          {c.nftTokenId
                            ? formatClaimAmount({
                                amount_eth: c.amountEth,
                                asset: c.asset,
                                nft_token_id: c.nftTokenId,
                              })
                            : `+${formatAmount(c.amountEth)} ${c.asset || 'ETH'}`}
                        </span>
                      </span>
                      {phoneOnly ? (
                        <span className="shrink-0 text-right font-sans text-[8.6px] text-[#a9a9a9]">
                          In the bot:
                          <br />
                          <span className="font-mono text-[#e6e6e6]">flizy claim</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn-sun hit-y-44 h-[28px] shrink-0 rounded-[4px] px-[13px] font-sans text-[10px]"
                          disabled={Boolean(claimBusyId)}
                          onClick={() => void onClaimOne(c.id)}
                        >
                          {claimBusyId === c.id ? 'Claiming...' : 'Claim'}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="m-0 mt-[9px] font-sans text-[8.6px] text-[#a9a9a9]">
                Phone money only moves after the number is proven in that chat app.
              </p>
            </>
          )}
        </AppCard>
      ) : null}

      {slide === 'go' ? (
        <AppCard className="!mt-[13.5px] px-[12px] pb-[12px] pt-[12.5px]">
          <AppCardHeader icon={<ArrowRightIcon size={15} />} title="Go" subtitle="Each one opens its own page or slide." />
          <div className="mt-[11px] grid grid-cols-2 gap-[5px]">
            <ActionRow
              href="/dashboard?s=claims"
              icon={<ArrowDownIcon size={13} />}
              label="Claims"
              hint={pendingClaims.length ? `${pendingClaims.length} held` : 'None'}
            />
            <ActionRow href="/dashboard/account?s=chat" icon={<BoltIcon size={13} />} label="Link chat" hint="WhatsApp, Telegram" />
            <ActionRow href="/dashboard/account?s=platforms" icon={<PeopleIcon size={13} />} label="Platforms" hint="GitHub and more" />
            <ActionRow
              href="/dashboard/account?s=profile"
              icon={<PersonIcon size={13} />}
              label="Username"
              hint={data.account.username ? `@${data.account.username}` : 'Set'}
            />
            <ActionRow href="/dashboard/wallet?s=fund" icon={<PlusCircleIcon size={13} />} label="Fund" hint="Deposit" />
            <ActionRow href="/dashboard/history" icon={<HistoryIcon size={13} />} label="History" hint="Activity" />
            <ActionRow href="/dashboard/swap" icon={<SwapArrowsIcon size={13} />} label="Swap" hint="FLZ" />
            <ActionRow href="/dashboard/account?s=pin" icon={<AlertCircleIcon size={13} />} label="PIN" hint="Lock" />
          </div>
          <div className="mt-[12px] border-t border-[#1f1f22] pt-[11px]">
            <p className="m-0 font-mono text-[8px] uppercase tracking-[0.1em] text-[#d0d0d0]">Chat link</p>
            <button
              type="button"
              className="btn-sun mt-[7px] h-[31px] w-full rounded-[4px] font-sans text-[10.5px]"
              onClick={() => generateLink()}
              disabled={busy === 'link'}
            >
              {busy === 'link' ? 'Working...' : data.link ? 'New code' : 'Generate link code'}
            </button>
            {data.link ? <p className="m-0 mt-[7px] font-mono text-[10px] text-sun">{data.link.code}</p> : null}
            <Link
              href="/dashboard/account?s=chat"
              className="mt-[7px] inline-block font-sans text-[9px] text-[#e6e6e6] no-underline hover:text-white"
            >
              Full chat link options
            </Link>
          </div>
        </AppCard>
      ) : null}

      {slide === 'recent' ? (
        <AppCard className="!mt-[13.5px] px-[12px] pb-[12px] pt-[12.5px]">
          <AppCardHeader
            icon={<HistoryIcon size={15} />}
            title="Recent"
            subtitle="Latest money moves. Full list on History."
            action={<CardLink href="/dashboard/history">See all</CardLink>}
          />
          {recent.length === 0 ? (
            <p className="m-0 mt-[11px] font-sans text-[9px] text-[#a9a9a9]">
              Nothing yet. After sends, claims, and swaps, they show here.
            </p>
          ) : (
            <ul className="m-0 mt-[11px] grid list-none gap-[5px] p-0">
              {recent.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-[10px] rounded-[5px] border border-[#1f1f22] bg-[#0f0f10] px-[11px] py-[9px]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-sans text-[10.5px] text-white">{row.label}</span>
                    <span className="block font-mono text-[8px] uppercase text-[#a9a9a9]">{row.status}</span>
                  </span>
                  <span
                    className={`shrink-0 font-sans text-[10.5px] font-semibold ${
                      row.direction === 'in' ? 'text-sun' : 'text-white'
                    }`}
                  >
                    {row.direction === 'in' ? '+' : '-'}
                    {formatAmount(row.amount)} {row.asset}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AppCard>
      ) : null}
      {comingSoonNote}
    </AppPage>
  );
}

const FIELD =
  'h-[31px] w-full rounded-[4px] border border-[#2a2b30] bg-[#0b0b0c] px-[10px] font-sans text-[10px] text-[#ececec] outline-none placeholder:text-[#8a8a8f] focus:border-sun/60';

function TileIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-[4px] border border-[#3a3017] bg-[#1c180c] text-sun">
      {children}
    </span>
  );
}

function StatTile({ href, icon, label, value }: { href: string; icon: ReactNode; label: string; value: string }) {
  return (
    <Link
      href={href}
      className="flex h-[75px] flex-col rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[9px] pt-[8px] no-underline"
    >
      <TileIcon>{icon}</TileIcon>
      <span className="mt-[7px] font-mono text-[7.6px] uppercase tracking-[0.1em] text-[#d0d0d0]">{label}</span>
      <span className="mt-[3px] flex items-center justify-between">
        <span className="font-sans text-[13px] font-semibold text-white">{value}</span>
        <ChevronRightIcon size={11} className="text-[#d9d9d9]" />
      </span>
    </Link>
  );
}

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="hit-y-44 flex h-[28px] items-center gap-[12px] rounded-[4px] border border-[#3a3b40] bg-[#0f0f10] px-[10px] font-sans text-[9.6px] text-[#ececec] no-underline hover:text-white"
    >
      {children}
      <ArrowRightIcon size={12} strokeWidth={1.8} />
    </Link>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-[21px] min-w-[21px] items-center justify-center rounded-[4px] border border-[#2a2b30] bg-[#141416] px-[6px] font-sans text-[9px] font-semibold text-[#ececec]">
      {children}
    </span>
  );
}

function ActionRow({ href, icon, label, hint }: { href: string; icon: ReactNode; label: string; hint?: string }) {
  return (
    <Link
      href={href}
      className="flex h-[36px] items-center gap-[9px] rounded-[5px] border border-[#1f1f22] bg-[#0f0f10] pl-[6px] pr-[8px] no-underline hover:border-[#2c2d32]"
    >
      <span className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[4px] bg-[#17171a] text-[#ececec]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[10px] text-white">{label}</span>
        {hint ? <span className="block truncate font-sans text-[7.8px] text-[#a9a9a9]">{hint}</span> : null}
      </span>
      <ChevronRightIcon size={11} className="shrink-0 text-[#cfcfcf]" />
    </Link>
  );
}

/**
 * The Flizy coin on the right of the balance, with a gold swell rising to it.
 * Drawn, not an image, so it stays sharp at any width.
 */
function HeroEmblem() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute right-0 top-0 h-full"
      viewBox="0 0 230 101"
      preserveAspectRatio="xMaxYMid meet"
    >
      <defs>
        <linearGradient id="home-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff1a8" />
          <stop offset="0.45" stopColor="#f7d047" />
          <stop offset="1" stopColor="#9c6c12" />
        </linearGradient>
        <radialGradient id="home-coin" cx="0.4" cy="0.35" r="0.75">
          <stop offset="0" stopColor="#2d220a" />
          <stop offset="1" stopColor="#0c0904" />
        </radialGradient>
        <radialGradient id="home-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f7c947" stopOpacity="0.35" />
          <stop offset="1" stopColor="#f7c947" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="home-swell" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f7c947" stopOpacity="0.28" />
          <stop offset="1" stopColor="#f7c947" stopOpacity="0" />
        </linearGradient>
        <filter id="home-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
      </defs>
      <ellipse cx="170" cy="52" rx="62" ry="50" fill="url(#home-glow)" />
      <path d="M30 101 C 84 100, 104 86, 124 76 S 164 54, 196 58 L 230 60 L 230 101 Z" fill="url(#home-swell)" />
      <g fill="none" stroke="url(#home-gold)" strokeLinecap="round">
        <path d="M0 101 C 60 99, 92 84, 118 72 S 160 50, 196 58" strokeWidth="1.6" opacity="0.9" filter="url(#home-soft)" />
        <path d="M0 101 C 60 99, 92 84, 118 72 S 160 50, 196 58" strokeWidth="0.9" />
        <path d="M10 101 C 70 98, 100 88, 124 78 S 166 60, 200 66" strokeWidth="0.6" opacity="0.6" />
        <path d="M24 101 C 82 99, 108 92, 130 84 S 170 70, 204 74" strokeWidth="0.5" opacity="0.4" />
      </g>
      <circle cx="170" cy="50" r="37" fill="url(#home-coin)" stroke="url(#home-gold)" strokeWidth="2.6" />
      <circle cx="170" cy="50" r="31" fill="none" stroke="#f7d047" strokeOpacity="0.35" strokeWidth="0.8" />
      <text
        x="170"
        y="64"
        textAnchor="middle"
        fontFamily="var(--font-geist-sans), sans-serif"
        fontSize="40"
        fontStyle="italic"
        fontWeight="800"
        fill="url(#home-gold)"
      >
        F
      </text>
    </svg>
  );
}
