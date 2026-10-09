'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useDashboard } from './DashboardProvider';
import { CheckIcon, ChevronRightIcon } from './ExploreIcons';
import { TX_EVENT } from '../lib/txSignal';

/**
 * First steps on Home: free test ETH, a first swap, a first payment.
 *
 * Most accounts finish sign-up and never move anything, so Home points at the
 * three things that make the wallet real. Each step ticks from the account's
 * own data (a sent faucet claim or a balance, a confirmed swap, a confirmed
 * send or claim), the card re-reads after every transaction, and it goes away
 * once all three are done or the person hides it.
 */

const HIDE_KEY = 'flizy:first-steps-hidden';

type Progress = { funded: boolean; swapped: boolean; sent: boolean };

function hiddenBefore(): boolean {
  try {
    return window.localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

export function FirstSteps() {
  const { data, holdings } = useDashboard();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [hidden, setHidden] = useState(true);

  const ready = Boolean(data?.account?.email_verified && String(data?.account?.username || '').trim());
  const balance = Number(holdings?.holdings?.native?.balance ?? 0);

  const load = useCallback(async () => {
    try {
      const [statsRes, faucetRes] = await Promise.all([fetch('/api/account/stats'), fetch('/api/faucet')]);
      const stats = await statsRes.json().catch(() => null);
      const faucet = await faucetRes.json().catch(() => null);
      if (!statsRes.ok || typeof stats?.swaps !== 'number' || typeof stats?.sends !== 'number') return;
      setProgress({
        funded: faucetRes.ok && (faucet?.lastClaim?.status === 'sent' || faucet?.lastClaim?.status === 'confirmed'),
        swapped: stats.swaps > 0,
        sent: stats.sends > 0,
      });
    } catch {
      // Without the figures the card stays away rather than guessing.
    }
  }, []);

  useEffect(() => {
    setHidden(hiddenBefore());
  }, []);

  useEffect(() => {
    if (!ready || hidden) return;
    void load();
    const onTx = () => window.setTimeout(() => void load(), 4000);
    window.addEventListener(TX_EVENT, onTx);
    return () => window.removeEventListener(TX_EVENT, onTx);
  }, [ready, hidden, load]);

  if (!ready || hidden || !progress) return null;

  const steps = [
    {
      done: progress.funded || balance > 0,
      title: 'Get free test ETH',
      sub: 'One tap in Wallet, Fund.',
      href: '/dashboard/wallet?s=fund',
    },
    {
      done: progress.swapped,
      title: 'Make your first swap',
      sub: 'Trade a little ETH for FLZ.',
      href: '/dashboard/swap',
    },
    {
      done: progress.sent,
      title: 'Pay someone',
      sub: "Send from WhatsApp or Telegram, or open a friend's pay link.",
      href: '/dashboard/account?s=chat',
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  function hide() {
    setHidden(true);
    try {
      window.localStorage.setItem(HIDE_KEY, '1');
    } catch {
      // Storage off: hidden for this visit only.
    }
  }

  return (
    <section className="rounded-[6px] border border-[#2a2b30] bg-[#0f0f10] px-[12px] pb-[10px] pt-[12px]" aria-label="First steps">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="m-0 font-sans text-[13px] font-semibold text-white">First steps</p>
          <p className="m-0 font-sans text-[11px] text-[#a9a9a9]">
            {doneCount} of {steps.length} done
          </p>
        </div>
        <button type="button" onClick={hide} className="hit-y-44 font-sans text-[11px] text-[#a9a9a9] hover:text-white">
          Hide
        </button>
      </div>
      <ol className="m-0 mt-[8px] grid list-none gap-[4px] p-0">
        {steps.map((step, i) => (
          <li key={step.title}>
            <Link
              href={step.href}
              className="flex min-h-[44px] items-center gap-[10px] rounded-[5px] px-[6px] py-[6px] no-underline hover:bg-[#151517]"
              aria-label={`${step.title}${step.done ? ', done' : ''}`}
            >
              <span
                className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${
                  step.done ? 'border-[#2fd27a]/60 bg-[#2fd27a]/10 text-[#2fd27a]' : 'border-sun/60 text-sun'
                }`}
                aria-hidden
              >
                {step.done ? <CheckIcon size={12} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block font-sans text-[12.5px] ${step.done ? 'text-[#8d8d8d] line-through' : 'text-white'}`}>{step.title}</span>
                <span className="block truncate font-sans text-[10.5px] text-[#9a9a9a]">{step.sub}</span>
              </span>
              <ChevronRightIcon size={13} className="shrink-0 text-[#6f6f6f]" />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
