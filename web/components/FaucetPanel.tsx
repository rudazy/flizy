'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useDashboard } from './DashboardProvider';
import { CopyButton } from './CopyButton';
import { CheckIcon, ChevronDownIcon, ExternalLinkIcon } from './ExploreIcons';
import type { FaucetAsset, FaucetStatus } from '../lib/faucet';
import { announceTx } from '../lib/txSignal';

/**
 * Wallet → Fund. One button per asset that puts test ETH, or test USD, in the
 * signed-in account's own Flizy wallet: no address to copy, no other site.
 * Amount, destination and each asset's wait are decided by the server
 * (lib/faucet.ts); this only shows them.
 */

const CARD = 'rounded-[14px] border border-[#232323] bg-[#101010]';
const PRIMARY_BUTTON =
  'hit-y-44 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-sun px-5 font-sans text-base font-semibold text-sun-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const GHOST_BUTTON =
  'hit-y-44 inline-flex h-11 items-center justify-center gap-2 rounded-[8px] border border-[#383838] px-4 font-sans text-sm text-[#f5f5f5] no-underline transition-colors hover:border-[#5a5a5a]';

/** Warm light behind the amount, the same glow the Projects workspace uses. */
const AMOUNT_BG =
  'radial-gradient(80% 110% at 50% 0%, rgba(70, 50, 16, 0.75) 0%, rgba(40, 30, 12, 0.35) 45%, rgba(11, 11, 11, 0) 80%), #0b0b0b';

/** What each card is called, and what it shows before the server answers. */
const DROP_COPY: Record<FaucetAsset, { query: string; title: string; caption: string; amount: string; unit: string; hours: number }> = {
  ETH: { query: '', title: 'GIWA ETH', caption: 'Testnet funds, for gas and payments', amount: '0.02', unit: 'ETH', hours: 72 },
  TUSD: { query: '?asset=tusd', title: 'tUSD', caption: 'Test dollars, for paying and getting paid', amount: '100', unit: 'tUSD', hours: 24 },
};

type Receipt = { amount: string; txUrl: string; nextClaimAt: string; status: 'confirmed' | 'sent' };

/** "71h 42m", "42m", or null once the time has passed. */
export function untilText(iso: string | null, now: number): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.ceil(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

export function FaucetPanel() {
  const { data } = useDashboard();
  const [username, setUsername] = useState('');
  const [now, setNow] = useState(() => Date.now());

  // The countdowns move on their own; a minute is the finest they show.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const address = data?.account.agent_wallet_address || '';
  const shownName = username || data?.account.username || '';

  return (
    <div className="grid gap-4">
      <header>
        <h2 className="m-0 font-sans text-xl font-semibold tracking-wide text-[#f5f5f5]">Fund</h2>
        <p className="m-0 mt-1 text-sm text-muted">Add test ETH and test dollars to your Flizy wallet.</p>
      </header>

      <DropCard asset="TUSD" now={now} onUsername={setUsername} />
      <DropCard asset="ETH" now={now} onUsername={setUsername} />

      <section className={`${CARD} p-5`}>
        <p className="m-0 font-sans text-[11px] uppercase tracking-[0.16em] text-[#8f8f8f]">Your wallet</p>
        <p className="m-0 mt-1 font-sans text-lg text-[#f5f5f5]">{shownName ? `@${shownName}` : 'Your Flizy wallet'}</p>
        <ul className="m-0 mt-4 grid list-none gap-2.5 p-0">
          {['Flizy wallet ready', 'No address needed', 'Sent straight to your wallet'].map((line) => (
            <li key={line} className="flex items-center gap-2.5 text-sm text-[#d6d6d6]">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-sun/40 bg-sun-wash text-sun">
                <CheckIcon size={11} />
              </span>
              {line}
            </li>
          ))}
        </ul>
      </section>

      {address ? (
        <details className={`${CARD} group p-5`}>
          <summary className="hit-y-44 flex cursor-pointer list-none items-center justify-between gap-3 font-sans text-sm text-[#d6d6d6] [&::-webkit-details-marker]:hidden">
            Receiving from another wallet?
            <ChevronDownIcon size={14} className="text-[#8f8f8f] transition-transform group-open:rotate-180" />
          </summary>
          <p className="mono-box mt-3 break-all text-sm">{address}</p>
          <div className="mt-2">
            <CopyButton value={address} label="Copy address" />
          </div>
          <p className="m-0 mt-3 text-xs leading-relaxed text-muted">
            Any token sent to this address is a deposit. Add its contract on Balances so it shows in the wallet. Only ETH,
            FLZ and tUSD can be sent on socials. Any token in the wallet can be traded.
          </p>
        </details>
      ) : null}
    </div>
  );
}

/** One asset's claim: its own status, button, receipt and wait. */
function DropCard({ asset, now, onUsername }: { asset: FaucetAsset; now: number; onUsername: (name: string) => void }) {
  const copy = DROP_COPY[asset];
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/faucet${copy.query}`);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || typeof body.amount !== 'string') {
        setLoadError(`Could not load the ${copy.unit} faucet.`);
        return;
      }
      setLoadError('');
      setStatus(body as FaucetStatus);
      if (typeof body.username === 'string') onUsername(body.username);
    } catch {
      setLoadError(`Could not load the ${copy.unit} faucet.`);
    }
  }, [copy.query, copy.unit, onUsername]);

  useEffect(() => {
    void load();
  }, [load]);

  async function claim() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/faucet/claim${copy.query}`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as Partial<Receipt> & { error?: unknown };
      if (!res.ok || typeof body.txUrl !== 'string' || typeof body.nextClaimAt !== 'string') {
        setError(typeof body.error === 'string' ? body.error : 'Could not claim. Try again.');
        void load();
        return;
      }
      setReceipt(body as Receipt);
      announceTx();
    } catch {
      setError('Could not claim. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const amount = status?.amount || copy.amount;
  const hours = status?.cooldownHours || copy.hours;
  const wait = untilText(receipt?.nextClaimAt ?? status?.nextClaimAt ?? null, now);

  if (loadError) {
    return (
      <section className={`${CARD} grid justify-items-start gap-3 p-5`}>
        <p className="m-0 text-sm text-[#e0b070]" role="alert">
          {loadError}
        </p>
        <button type="button" className={GHOST_BUTTON} onClick={() => void load()}>
          Try again
        </button>
      </section>
    );
  }
  if (!status) {
    return <div className={`${CARD} h-[260px] animate-pulse`} aria-busy="true" aria-label={`Loading the ${copy.unit} faucet`} />;
  }
  if (receipt || (wait && status.lastClaim)) {
    return (
      <Funded
        amount={receipt?.amount || amount}
        title={copy.title}
        wait={wait}
        txUrl={receipt?.txUrl || status.lastClaim?.txUrl || null}
        justNow={Boolean(receipt)}
        pending={(receipt?.status || status.lastClaim?.status) === 'sent'}
      />
    );
  }
  return (
    <section className={`${CARD} overflow-hidden`}>
      <div className="grid justify-items-center gap-1 px-5 pb-6 pt-8 text-center" style={{ background: AMOUNT_BG }}>
        <p className="m-0 font-sans text-[56px] font-semibold leading-none tracking-wide text-[#f5f5f5]">{amount}</p>
        <p className="m-0 mt-1 font-sans text-base tracking-wide text-sun">{copy.title}</p>
        <p className="m-0 mt-3 font-sans text-[11px] uppercase tracking-[0.2em] text-[#8f8f8f]">{copy.caption}</p>
      </div>
      <div className="grid gap-3 p-5">
        {status.eligible ? (
          <button type="button" className={PRIMARY_BUTTON} onClick={() => void claim()} disabled={busy}>
            {busy ? 'Sending to your wallet' : `Claim ${amount} ${copy.unit}`}
          </button>
        ) : (
          <>
            <button type="button" className={PRIMARY_BUTTON} disabled>
              Claim {amount} {copy.unit}
            </button>
            <p className="m-0 text-center text-sm text-[#e0b070]">
              {status.reason}{' '}
              {status.fix === 'profile' ? (
                <Link href="/dashboard/account" className="text-sun no-underline hover:underline">
                  Open Profile
                </Link>
              ) : null}
            </p>
          </>
        )}
        {error ? (
          <p className="m-0 text-center text-sm text-[#e0b070]" role="alert">
            {error}
          </p>
        ) : null}
        <p className="m-0 text-center text-xs text-muted">Available once every {hours} hours.</p>
      </div>
    </section>
  );
}

function Funded({
  amount,
  title,
  wait,
  txUrl,
  justNow,
  pending,
}: {
  amount: string;
  title: string;
  wait: string | null;
  txUrl: string | null;
  justNow: boolean;
  pending: boolean;
}) {
  return (
    <section className={`${CARD} overflow-hidden`}>
      <div className="grid justify-items-center gap-1 px-5 pb-6 pt-7 text-center" style={{ background: AMOUNT_BG }}>
        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-sun/50 bg-sun-wash text-sun shadow-[0_0_32px_rgba(247,208,71,0.25)]">
          <CheckIcon size={22} />
        </span>
        <p className="m-0 mt-3 font-sans text-sm uppercase tracking-[0.2em] text-sun">{justNow ? 'Funded' : 'Claimed'}</p>
        <p className="m-0 mt-2 font-sans text-[40px] font-semibold leading-none tracking-wide text-[#f5f5f5]">
          +{amount} <span className="text-[22px] text-sun">{title}</span>
        </p>
        <p className="m-0 mt-3 text-sm text-[#bdbdbd]">
          {pending ? 'On its way to your Flizy wallet.' : 'Sent straight to your Flizy wallet.'}
        </p>
      </div>
      <div className="grid gap-4 p-5">
        <div className="text-center">
          <p className="m-0 font-sans text-[11px] uppercase tracking-[0.16em] text-[#8f8f8f]">Next claim</p>
          <p className="m-0 mt-1 font-mono text-2xl text-[#f5f5f5]">{wait ? `in ${wait}` : 'Available now'}</p>
        </div>
        {txUrl ? (
          <a href={txUrl} target="_blank" rel="noreferrer noopener" className={`${GHOST_BUTTON} w-full`}>
            View transaction
            <ExternalLinkIcon size={13} className="text-[#8f8f8f]" />
          </a>
        ) : null}
      </div>
    </section>
  );
}
