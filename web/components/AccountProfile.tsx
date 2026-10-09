'use client';

import type { ReactNode } from 'react';
import { useEffect, useId, useState } from 'react';
import {
  ChartLineIcon,
  ChevronRightIcon,
  EthDiamondIcon,
  EyeIcon,
  GlobeIcon,
  LockIcon,
  PeopleIcon,
  PersonIcon,
  ScanIcon,
  ShieldCheckIcon,
  UserPlusIcon,
  WalletIcon,
} from './ExploreIcons';

/**
 * The Account profile, drawn to the phone layout.
 *
 * This is the signed-in account, so it does not offer Follow. Delete opens
 * the closure sheet. Figures that Flizy does not store stay blank. Invite
 * and credit counts are the account's own.
 */

type Props = {
  username: string;
  displayName: string;
  email: string;
  address: string;
  invites: number;
  credits: number;
  emailPanel: ReactNode;
  usernamePanel: ReactNode;
  namePanel: ReactNode;
  onEmail: () => void;
  onUsername: () => void;
  onName: () => void;
  onWallet: () => void;
  onSecurity: () => void;
  onSoon: (what: string) => void;
  onOpen: (id: string) => void;
  onDelete: () => void;
  /** Same sign-out as Security, also offered from More so it is easy to find. */
  onSignOut: () => void;
};

const TAGS = ['Wallet', 'Social', 'Payments', 'Onchain', 'Global'];

function Mark({ children }: { children: ReactNode }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-[#3a3424] bg-[#1c1812] text-[#f7d047]">
      {children}
    </span>
  );
}

function Card({
  icon,
  title,
  hint,
  extra,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[16px] border border-[#2a2b30] bg-[#101012]">
      <div className="flex items-start gap-3 px-3.5 pb-2 pt-3.5">
        <Mark>{icon}</Mark>
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="font-sans text-[15px] font-semibold leading-tight text-white">{title}</h2>
          <p className="mt-0.5 font-sans text-[12px] leading-snug text-[#8d867c]">{hint}</p>
        </div>
        {extra}
      </div>
      {children}
    </section>
  );
}

function Row({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[44px] w-full items-center gap-3 border-t border-[#26262a] px-3.5 py-2 text-left"
    >
      <span className="text-[#c8c2b8]">{icon}</span>
      <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[#f3f1ec]">{label}</span>
      {value ? (
        <span className="max-w-[48%] truncate text-right font-sans text-[12px] text-[#b7b1a8]">{value}</span>
      ) : null}
      <ChevronRightIcon size={16} className="shrink-0 text-[#6f6a62]" />
    </button>
  );
}

function SoonToggle({
  on,
  label,
  icon,
  onSoon,
}: {
  on: boolean;
  label: string;
  icon: ReactNode;
  onSoon: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSoon}
      aria-label={`${label}. Not available yet.`}
      className="hit-y-44 flex min-h-[44px] w-full items-center gap-3 border-t border-[#26262a] px-3.5 py-2 text-left"
    >
      <span className="text-[#c8c2b8]">{icon}</span>
      <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-[#f3f1ec]">{label}</span>
      <span
        className={`relative h-[22px] w-[40px] shrink-0 rounded-full ${on ? 'bg-[#f7d047]' : 'bg-[#3a3a3e]'}`}
        aria-hidden
      >
        <span
          className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white ${on ? 'left-[20px]' : 'left-[2px]'}`}
        />
      </span>
    </button>
  );
}

/**
 * "Show username on Scan": a real setting, off by default, saved as soon as it
 * is flipped. Off, Scan never shows the @username: payments to this account
 * show its short wallet address, and its own payments show only how they
 * travelled.
 */
function ScanUsernameToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    // A request that never answers would leave this on Loading for good.
    const abort = new AbortController();
    const timer = window.setTimeout(() => abort.abort(), 10000);
    fetch('/api/account/scan-visibility', { signal: abort.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (live && res.ok && typeof data.showUsername === 'boolean') setOn(data.showUsername);
        else if (live) setError('Could not load this setting.');
      })
      .catch(() => live && setError('Could not load this setting. Reload to try again.'))
      .finally(() => window.clearTimeout(timer));
    return () => {
      live = false;
      window.clearTimeout(timer);
      abort.abort();
    };
  }, []);

  async function flip() {
    if (on == null || busy) return;
    const next = !on;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/account/scan-visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showUsername: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.showUsername !== 'boolean') throw new Error();
      setOn(data.showUsername);
    } catch {
      setError('That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-[#26262a]">
      <button
        type="button"
        role="switch"
        aria-checked={on === true}
        disabled={on == null || busy}
        onClick={() => void flip()}
        className="hit-y-44 flex min-h-[44px] w-full items-center gap-3 px-3.5 py-2 text-left disabled:opacity-60"
      >
        <span className="text-[#c8c2b8]">
          <ScanIcon size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-sans text-[13px] text-[#f3f1ec]">Show username on Scan</span>
          <span className="block font-sans text-[11.5px] leading-[16px] text-[#8f8a82]">
            {on === null
              ? error || 'Loading...'
              : on
                ? 'On: your @username shows on payments you send and receive.'
                : 'Off: Scan shows your short wallet address, never your username.'}
          </span>
        </span>
        <span className={`relative h-[22px] w-[40px] shrink-0 rounded-full ${on ? 'bg-[#f7d047]' : 'bg-[#3a3a3e]'}`} aria-hidden>
          <span className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white ${on ? 'left-[20px]' : 'left-[2px]'}`} />
        </span>
      </button>
      {error && on !== null ? <p className="m-0 px-3.5 pb-2 font-sans text-[11.5px] text-[#e0b070]">{error}</p> : null}
    </div>
  );
}

function CopyGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <rect x="9" y="9" width="11" height="11" rx="2" strokeWidth="1.7" />
      <path d="M5 15V5h10" strokeWidth="1.7" />
    </svg>
  );
}

export function AccountProfile({
  username,
  displayName,
  email,
  address,
  invites,
  credits,
  emailPanel,
  usernamePanel,
  namePanel,
  onEmail,
  onUsername,
  onName,
  onWallet,
  onSecurity,
  onSoon,
  onOpen,
  onDelete,
  onSignOut,
}: Props) {
  const stats = useAccountStats();
  const [more, setMore] = useState(false);
  const [copied, setCopied] = useState(false);
  const silkId = useId().replace(/:/g, '');
  const handle = username ? `@${username}` : 'Set a username';
  const short = address && address.length >= 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address;
  const mid =
    address && address.length >= 22 ? `${address.slice(0, 14)}...${address.slice(-8)}` : short;

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      onSoon('Copy');
    }
  }

  return (
    <div className="space-y-3">
      <section className="relative rounded-[18px] border border-[#3a3424] bg-[#100e0b]">
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[18px]" aria-hidden>
          <div className="absolute inset-y-0 right-0 w-[62%] bg-[radial-gradient(90%_80%_at_72%_42%,rgba(255,226,140,0.55),rgba(247,208,71,0.16)_46%,transparent_72%)]" />
          <svg className="absolute inset-y-0 right-0 h-full w-[64%]" viewBox="0 0 260 200" preserveAspectRatio="xMaxYMid slice" fill="none">
            <defs>
              <linearGradient id={`${silkId}-stroke`} x1="0" y1="0" x2="1" y2="0.2">
                <stop offset="0%" stopColor="#f7d047" stopOpacity="0" />
                <stop offset="28%" stopColor="#fff1c2" stopOpacity="0.95" />
                <stop offset="62%" stopColor="#f7d047" stopOpacity="0.7" />
                <stop offset="100%" stopColor="#f7d047" stopOpacity="0.05" />
              </linearGradient>
              <filter id={`${silkId}-blur`} x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="1.15" />
              </filter>
            </defs>
            <g filter={`url(#${silkId}-blur)`} stroke={`url(#${silkId}-stroke)`} strokeLinecap="round">
              <path d="M-30 42c52-30 98-6 140 10 36 14 72 6 140-26" strokeWidth="1.4" />
              <path d="M-40 74c60-42 112-10 158 12 40 18 78 4 150-34" strokeWidth="2.6" />
              <path d="M-16 108c54-36 108-6 150 12 38 16 74 2 140-28" strokeWidth="1.5" />
              <path d="M8 142c48-26 100 0 138 12 34 10 70 0 120-20" strokeWidth="1.1" />
            </g>
          </svg>
        </div>

        <div className="relative px-3.5 pb-3.5 pt-3.5">
          <div className="flex items-start gap-3">
            <div className="relative h-[72px] w-[72px] shrink-0">
              <span className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-[2px] border-[#f7d047] bg-[#14120e] font-sans text-[32px] font-bold text-[#f7d047]">
                {(username || displayName || 'F').slice(0, 1).toUpperCase()}
              </span>
              <button
                type="button"
                onClick={onUsername}
                aria-label="Change username"
                className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-[#3a3a3e] bg-[#2a2a2e] text-[#f3f1ec]"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                  <path strokeWidth="1.8" d="M4 20h4l10-10-4-4L4 16z" />
                  <path strokeWidth="1.8" d="M13 7l4 4" />
                </svg>
              </button>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 pt-0.5">
                  <p className="flex items-center gap-1.5 font-sans text-[18px] font-bold leading-none text-white">
                    <span className="truncate">{handle}</span>
                    {username ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" className="shrink-0 text-[#f7d047]" aria-hidden>
                        <circle cx="12" cy="12" r="9" fill="currentColor" />
                        <path d="M8 12.2l2.4 2.4L16.2 9" fill="none" stroke="#1a1405" strokeWidth="2" />
                      </svg>
                    ) : null}
                  </p>
                  {displayName ? (
                    <p className="mt-1 truncate font-sans text-[12px] text-[#c8c2b8]">{displayName}</p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onSoon('Change banner')}
                  className="hit-y-44 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] border border-[#5a5138] bg-[#16130e]/75 px-2.5 font-sans text-[11px] font-medium text-[#f3ead2]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                    <path strokeWidth="1.7" d="M4 8.5h3l1.4-2h7.2L17 8.5h3v10H4z" />
                    <circle cx="12" cy="13" r="2.6" strokeWidth="1.7" />
                  </svg>
                  Change banner
                </button>
              </div>
              {address ? (
                <button
                  type="button"
                  onClick={() => void copyAddress()}
                  className="hit-y-44 mt-2 inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-[#2e2e32] bg-[#0c0c0e]/80 px-2 font-mono text-[11px] text-[#d9d4cc]"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#161616] text-[#e6e6e6]">
                    <EthDiamondIcon size={10} />
                  </span>
                  <span className="whitespace-nowrap">{copied ? 'Copied' : short}</span>
                  <CopyGlyph />
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-1">
            <div className="flex min-w-0 flex-1 flex-nowrap gap-[3px]">
              {TAGS.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-[#3a3a3e] px-1 py-[3px] font-sans text-[9px] leading-none text-[#d5d0c8] sm:px-1.5 sm:text-[10px]"
                >
                  {tag}
                </span>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label="More account tools"
                aria-expanded={more}
                onClick={() => setMore((open) => !open)}
                className="hit-44 flex h-7 w-7 items-center justify-center rounded-[10px] border border-[#3a3a3e] bg-[#161616] text-[#f3f1ec]"
              >
                <span className="font-sans text-[16px] leading-none tracking-widest">...</span>
              </button>
            </div>
          </div>
          {more ? (
            <div className="relative z-20 mt-2 rounded-[12px] border border-[#3a3424] bg-[#16130e] p-1">
              {[
                ['country', 'Country'],
                ['chat', 'Chat'],
                ['platforms', 'Platforms'],
                ['trusted', 'Trusted wallets'],
                ['pin', 'PIN'],
                ['limits', 'Daily limit'],
                ['security', 'Security'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setMore(false);
                    onOpen(id);
                  }}
                  className="flex min-h-[44px] w-full items-center rounded-[8px] px-3 text-left font-sans text-[13px] text-[#f3f1ec] hover:bg-[#241f16]"
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setMore(false);
                  onSignOut();
                }}
                className="mt-1 flex min-h-[44px] w-full items-center rounded-[8px] border-t border-[#3a3424] px-3 text-left font-sans text-[13px] text-[#f0a3a3] hover:bg-[#241f16]"
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section className="grid grid-cols-4 divide-x divide-[#2a2b30] rounded-[14px] border border-[#2a2b30] bg-[#101012] px-1 py-2.5">
        <Stat icon={<ChartLineIcon size={14} />} value={stats ? volumeText(stats.volumeEth) : '-'} label="Total volume" />
        <Stat icon={<SwapGlyph />} value={stats ? String(stats.swaps) : '-'} label="Swaps" />
        <Stat icon={<PeopleIcon size={14} />} value="0" label="Followers" />
        <Stat
          icon={<StarGlyph />}
          value="-"
          label="Followers' volume"
          note={
            <button
              type="button"
              onClick={() => onSoon("Followers' volume")}
              aria-label="About followers' volume"
              className="hit-y-44 inline-flex text-[#6f6a62]"
            >
              <InfoGlyph />
            </button>
          }
        />
      </section>

      <Card
        icon={<PersonIcon size={16} />}
        title="Account Information"
        hint="Manage your basic details and identity."
        extra={
          <button
            type="button"
            onClick={onName}
            className="hit-y-44 inline-flex h-8 items-center rounded-[10px] border border-[#f7d047] px-3 font-sans text-[12px] font-semibold text-[#f7d047]"
          >
            Edit
          </button>
        }
      >
        <Row icon={<MailGlyph />} label="Email" value={email || 'Not set'} onClick={onEmail} />
        <Row icon={<AtGlyph />} label="Username" value={username ? `@${username}` : 'Not set'} onClick={onUsername} />
        <Row icon={<PersonIcon size={16} />} label="Display name" value={displayName || 'Not set'} onClick={onName} />
        <Row icon={<FileGlyph />} label="Bio" value="Not set" onClick={() => onSoon('Bio')} />
        {emailPanel || usernamePanel || namePanel ? (
          <div className="border-t border-[#26262a] px-3.5 py-3">{emailPanel || usernamePanel || namePanel}</div>
        ) : null}
      </Card>

      <Card
        icon={<WalletIcon size={16} />}
        title="Flizy Wallet"
        hint="Your default wallet for all Flizy transactions."
        extra={
          <span className="rounded-full border border-[#1f6b45] bg-[#123224] px-2 py-1 font-sans text-[10px] font-semibold text-[#3ddc84]">
            Primary
          </span>
        }
      >
        <div className="flex min-h-[52px] w-full items-center gap-2.5 border-t border-[#26262a] px-3.5 py-2">
          <button type="button" onClick={onWallet} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#161616] text-[#e6e6e6]">
              <EthDiamondIcon size={14} />
            </span>
            <span className="whitespace-nowrap font-mono text-[11px] text-[#f3f1ec] sm:hidden">
              {address ? `${address.slice(0, 8)}...${address.slice(-4)}` : 'Not set'}
            </span>
            <span className="hidden whitespace-nowrap font-mono text-[12px] text-[#f3f1ec] sm:inline">
              {mid || 'Not set'}
            </span>
          </button>
          <button
            type="button"
            onClick={() => void copyAddress()}
            aria-label={copied ? 'Copied' : 'Copy wallet address'}
            className="hit-44 inline-flex text-[#b7b1a8]"
          >
            <CopyGlyph />
          </button>
          <button type="button" onClick={onWallet} className="inline-flex shrink-0 items-center gap-1 font-sans text-[11px] text-[#b7b1a8]">
            GIWA · Ethereum
            <ChevronRightIcon size={16} className="text-[#6f6a62]" />
          </button>
        </div>
      </Card>

      <Card icon={<BarsGlyph />} title="Stats & Social" hint="Your activity, followers and community.">
        <div className="grid grid-cols-4 gap-1.5 border-t border-[#26262a] px-3 py-3">
          <Mini icon={<UserPlusIcon size={14} />} value={String(invites)} label="Invites" />
          <Mini icon={<CoinsGlyph />} value={String(credits)} label="Credits" />
          <Mini icon={<PeopleIcon size={14} />} value="0" label="Followers" />
          <Mini icon={<PersonIcon size={14} />} value="0" label="Following" />
        </div>
      </Card>

      <Card icon={<EyeIcon size={16} />} title="Privacy & Visibility" hint="Control what others can see of your profile.">
        <Row icon={<GlobeIcon size={16} />} label="Profile visibility" value="Public" onClick={() => onSoon('Profile visibility')} />
        <ScanUsernameToggle />
        <SoonToggle on icon={<ChartLineIcon size={16} />} label="Show trading stats" onSoon={() => onSoon('Show trading stats')} />
        <SoonToggle on icon={<PeopleIcon size={16} />} label="Show followers & following" onSoon={() => onSoon('Show followers and following')} />
        <SoonToggle on={false} icon={<WalletIcon size={16} />} label="Show wallet address" onSoon={() => onSoon('Show wallet address')} />
        <SoonToggle on={false} icon={<PieGlyph />} label="Show portfolio value" onSoon={() => onSoon('Show portfolio value')} />
      </Card>

      <Card icon={<ShieldCheckIcon size={16} />} title="Security" hint="Keep your account safe.">
        <Row icon={<LockIcon size={16} />} label="Change password" onClick={onSecurity} />
        <Row icon={<DevicesGlyph />} label="Connected devices" value="-" onClick={() => onSoon('Connected devices')} />
        <Row icon={<ShieldCheckIcon size={16} />} label="Two-factor authentication" value="Not enabled" onClick={() => onSoon('Two-factor authentication')} />
      </Card>

      <button
        type="button"
        onClick={onDelete}
        className="flex min-h-[64px] w-full items-center gap-3 rounded-[16px] border border-[#6b2430] bg-[#2a1216] px-3.5 py-3 text-left"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-[#6b2430] text-[#f05252]">
          <TrashGlyph />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-sans text-[14px] font-semibold text-[#f05252]">Delete account</span>
          <span className="mt-0.5 block font-sans text-[12px] text-[#c48b93]">
            Deactivate, or delete the sign-in. This takes several steps.
          </span>
        </span>
        <ChevronRightIcon size={16} className="shrink-0 text-[#f05252]" />
      </button>
    </div>
  );
}

/** ETH moved, short enough for a stat tile. */
function volumeText(eth: number): string {
  if (!(eth > 0)) return '0';
  if (eth < 0.001) return '<0.001';
  return eth.toLocaleString('en-US', { maximumFractionDigits: eth < 1 ? 3 : 2 });
}

/** Swaps and ETH volume from /api/account/stats; null until read, and on failure. */
function useAccountStats(): { swaps: number; volumeEth: number } | null {
  const [stats, setStats] = useState<{ swaps: number; volumeEth: number } | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/account/stats')
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (live && res.ok && typeof body.swaps === 'number' && typeof body.volumeEth === 'number') setStats(body);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return stats;
}

function Stat({
  icon,
  value,
  label,
  note,
}: {
  icon: ReactNode;
  value: string;
  label: string;
  note?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-1 text-center">
      <p className="flex items-center justify-center gap-1 font-sans text-[15px] font-bold leading-none text-white">
        <span className="text-[#f7d047]">{icon}</span>
        {value}
      </p>
      <p className="mt-1 flex items-center justify-center gap-0.5 whitespace-nowrap font-sans text-[8px] leading-none text-[#8d867c]">
        <span>{label}</span>
        {note}
      </p>
    </div>
  );
}

function Mini({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="min-w-0 rounded-[12px] border border-[#2a2b30] bg-[#0c0c0e] px-1.5 py-2">
      <p className="flex items-center gap-1 font-sans text-[13px] font-bold text-[#f7d047]">
        {icon}
        <span className="text-white">{value}</span>
      </p>
      <p className="mt-0.5 flex items-center justify-between gap-1 font-sans text-[9px] text-[#8d867c]">
        <span className="truncate">{label}</span>
        <ChevronRightIcon size={12} />
      </p>
    </div>
  );
}

function MailGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" strokeWidth="1.7" />
      <path d="M4 7l8 6 8-6" strokeWidth="1.7" />
    </svg>
  );
}

function AtGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="3.2" strokeWidth="1.7" />
      <path d="M15.2 12v1.4a2 2 0 0 0 4 0V12a7.2 7.2 0 1 0-2.8 5.7" strokeWidth="1.7" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path d="M7 3.5h7l4 4V20.5H7z" strokeWidth="1.7" />
      <path d="M14 3.5V8h4.5M9 12.5h6M9 16h6" strokeWidth="1.7" />
    </svg>
  );
}

function BarsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path d="M5 19V10M12 19V5M19 19v-7" strokeWidth="1.8" />
    </svg>
  );
}

function SwapGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path d="M7 7h11l-3-3M17 17H6l3 3" strokeWidth="1.8" />
    </svg>
  );
}

function StarGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3.2l2.4 5.6 6 .6-4.5 4 1.3 5.9L12 16.6 6.8 19.3 8.1 13.4 3.6 9.4l6-.6z" />
    </svg>
  );
}

function CoinsGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <ellipse cx="12" cy="7" rx="7" ry="3" strokeWidth="1.6" />
      <path d="M5 7v4c0 1.7 3.1 3 7 3s7-1.3 7-3V7M5 11v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4" strokeWidth="1.6" />
    </svg>
  );
}

function DevicesGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <rect x="3.5" y="7" width="8" height="13" rx="1.6" strokeWidth="1.6" />
      <rect x="12" y="4" width="8.5" height="13" rx="1.6" strokeWidth="1.6" />
      <path d="M15.2 14.5h2" strokeWidth="1.6" />
    </svg>
  );
}

function PieGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="8" strokeWidth="1.7" />
      <path d="M12 12V4.2" strokeWidth="1.7" />
      <path d="M12 12l6.2 3.6" strokeWidth="1.7" />
    </svg>
  );
}

function InfoGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="8.5" strokeWidth="1.7" />
      <path d="M12 11v5" strokeWidth="1.8" />
      <circle cx="12" cy="8" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <path d="M5 7h14M9 7V5h6v2M8 7l1 13h6l1-13" strokeWidth="1.7" />
    </svg>
  );
}
