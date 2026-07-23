'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../components/AppTopBar';
import { useDashboard } from '../../components/DashboardProvider';
import { shortAddr } from '../../lib/dashboardTypes';

export default function DashboardHomePage() {
  const search = useSearchParams();
  const welcome = search.get('welcome') === '1';
  const { data, holdings, generateLink, busy, refreshing, refreshAll, setUnlockPin, setMsg } =
    useDashboard();
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');

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
        done: data.account.has_pin,
        title: 'Unlock PIN (required)',
        body: data.account.has_pin ? 'Set' : 'Required for flizy unlock after lock',
        href: '/dashboard/account',
      },
      {
        done: data.trusted.length > 0,
        title: 'Trusted wallet added',
        body: data.trusted.length ? `${data.trusted.length} saved` : 'Required for sends',
        href: '/dashboard/account',
      },
      {
        done: Boolean(data.link),
        title: 'WhatsApp linked',
        body: data.link ? `Code ${data.link.code}` : 'Generate code and open bot',
        href: '/dashboard/account',
      },
    ];
  }, [data]);

  if (!data) return null;

  const nativeBal = holdings?.holdings?.native;
  const credit = data.account.balance_eth ?? 0;
  const needsPin = !data.account.has_pin;

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
    const ok = await setUnlockPin(pin);
    if (ok) {
      setPin('');
      setPin2('');
    }
  }

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
          Welcome. Set your unlock PIN first, then connect WhatsApp. The bot opens with your link
          code already filled in.
        </div>
      ) : null}

      {/* Required: unlock PIN (not optional) */}
      {needsPin ? (
        <section className="card space-y-3 border-gold/40 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-sans text-sm tracking-wide text-paper">Set unlock PIN</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                Required. After <span className="text-paper">flizy lock</span>, you unlock with this
                PIN (or your account password). 4-12 digits.
              </p>
            </div>
            <span className="badge badge-gold shrink-0">Required</span>
          </div>
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
            <button
              type="submit"
              className="btn btn-primary w-full py-3 font-semibold sm:col-span-2"
              disabled={busy === 'pin'}
            >
              {busy === 'pin' ? 'Saving...' : 'Save unlock PIN'}
            </button>
          </form>
        </section>
      ) : null}

      {/* Primary path: open bot with link code (no need to know bot number) */}
      <section className="card space-y-3 border-lime/25 p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-sans text-sm tracking-wide text-paper">Connect WhatsApp</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Generates a one-time code and opens the Flizy bot chat with the message ready to send.
              Friends never need your personal number.
            </p>
          </div>
          <span className="badge badge-gold shrink-0">{data.link ? 'Code ready' : 'Required'}</span>
        </div>
        {data.link ? (
          <div className="rounded-md border border-border bg-ink/70 p-3">
            <p className="font-mono text-lg text-lime">{data.link.code}</p>
            <p className="mt-1 font-mono text-[11px] text-muted">flizy link {data.link.code}</p>
          </div>
        ) : null}
        <button
          type="button"
          className="btn btn-primary w-full py-3.5 text-base font-semibold"
          onClick={() => generateLink()}
          disabled={busy === 'link'}
        >
          {busy === 'link'
            ? 'Opening WhatsApp...'
            : data.link
              ? 'Open WhatsApp bot again'
              : 'Generate code and open WhatsApp'}
        </button>
        {data.link?.waDeepLink ? (
          <a
            href={data.link.waDeepLink}
            className="btn btn-ghost flex w-full items-center justify-center py-3 text-sm no-underline"
            target="_blank"
            rel="noreferrer"
          >
            Open bot link without regenerating
          </a>
        ) : null}
      </section>

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
          Lock the bot with flizy lock if your phone is shared.
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
                : '- ETH'}
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
          <Link href="/dashboard/account" className="btn btn-ghost text-sm no-underline">
            Account and PIN
          </Link>
          <Link href="/dashboard/history" className="btn btn-ghost text-sm no-underline">
            History
          </Link>
        </div>
      </section>

      {/* Fund agent wallet — faucet/bridge cannot use the Flizy smart wallet */}
      <section id="fund" className="card scroll-mt-20 space-y-4 p-4 sm:p-5">
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-gold">Testnet funding</p>
          <h2 className="mt-1.5 font-sans text-lg tracking-wide text-paper">
            Fund your agent wallet
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Google faucet and the GIWA bridge only work with a normal browser wallet
            (MetaMask or Rabby). Your Flizy agent address is a smart wallet — it cannot claim
            faucet ETH or drive the bridge by itself. Fund a regular wallet first, then send
            GIWA Sepolia ETH to the address on Wallet.
          </p>
        </div>

        <ol className="space-y-3">
          {[
            {
              n: '1',
              t: 'Open MetaMask or Rabby',
              d: 'Use a regular EOA wallet in the browser. Add or switch to Ethereum Sepolia if needed.',
            },
            {
              n: '2',
              t: 'Claim Sepolia ETH from Google faucet',
              d: 'Connect that wallet to the faucet and request test ETH. Do not paste your Flizy agent address into the faucet.',
              href: 'https://cloud.google.com/application/web3/faucet',
              linkLabel: 'Open Google faucet',
            },
            {
              n: '3',
              t: 'Bridge to GIWA Sepolia',
              d: 'Use the GIWA bridge with the same MetaMask/Rabby wallet. Bridge Sepolia ETH onto GIWA Sepolia.',
              href: 'https://bridge-giwa.vercel.app/',
              linkLabel: 'Open GIWA bridge',
            },
            {
              n: '4',
              t: 'Send to your Flizy agent wallet',
              d: 'On GIWA Sepolia, transfer ETH from MetaMask/Rabby to your agent address (Wallet tab → Copy address). Then use WhatsApp or Swap.',
              href: '/dashboard/wallet',
              linkLabel: 'Open wallet & copy address',
            },
          ].map((step) => (
            <li
              key={step.n}
              className="flex gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-ink font-mono text-[11px] text-lime">
                {step.n}
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-sans text-sm tracking-wide text-paper">{step.t}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">{step.d}</p>
                {'href' in step && step.href ? (
                  <a
                    href={step.href}
                    className="mt-2 inline-block text-xs text-lime no-underline hover:text-gold"
                    target={step.href.startsWith('http') ? '_blank' : undefined}
                    rel={step.href.startsWith('http') ? 'noreferrer' : undefined}
                  >
                    {step.linkLabel} →
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ol>

        {data.account.agent_wallet_address ? (
          <div className="rounded-md border border-border bg-ink/50 px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-[0.12em] text-muted">
              Send GIWA ETH to this address
            </p>
            <p className="mt-1 break-all font-mono text-[11px] text-paper">
              {data.account.agent_wallet_address}
            </p>
          </div>
        ) : null}
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
