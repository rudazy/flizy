'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AppTopBar } from '../../../components/AppTopBar';
import {
  AppPage,
  AppSection,
  AppSlideNav,
  useSlide,
} from '../../../components/AppSection';
import { ActivityPanels } from '../../../components/ActivityPanels';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';
import { isHeld } from '../../../lib/dashboardTypes';
import { VerifiedMark } from '../../../components/VerifiedMark';
import { BalanceEye } from '../../../components/BalanceEye';

/**
 * Order is the product lock of 2026-09-17: Balances | History | Fund | Power.
 * History sits second because it is the thing people check after a balance,
 * not an afterthought behind the funding instructions.
 */
const SLIDES = ['balances', 'history', 'fund', 'power'] as const;

function tokenHref(token: { symbol: string; address: string | null; verified?: boolean }): string | null {
  if (token.verified && token.symbol.toUpperCase() === 'FLZ') return '/dashboard/explore/tokens/flz';
  if (token.address) return `/dashboard/explore/tokens/${token.address}`;
  return null;
}

export default function WalletPage() {
  const { data, holdings, explorerBase, refreshing, refreshAll } = useDashboard();
  const [slide, setSlide] = useSlide(SLIDES, 'balances');
  const [contract, setContract] = useState('');
  const [tokenNote, setTokenNote] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [addingToken, setAddingToken] = useState(false);
  const [balancesHidden, setBalancesHidden] = useState(false);

  // Only what the wallet actually holds. The API returns every tracked token and
  // listed collection at zero so other callers can read the balance; this list
  // shows a row only when there is something in it. See isHeld — an unreadable
  // row stays visible rather than being reported as none.
  const tokens = (holdings?.holdings?.tokens || []).filter((t) => isHeld(t.balance));
  const nfts = (holdings?.holdings?.nfts || []).filter((n) => isHeld(n.balance));

  async function addToken() {
    if (tokenBusy || !contract.trim()) return;
    setTokenBusy(true);
    setTokenError('');
    setTokenNote('');
    try {
      const res = await fetch('/api/wallet/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: contract }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTokenError(body.error || 'Could not add that token.');
        return;
      }
      const symbol = body.token?.symbol || 'Token';
      const balance = body.token?.balance;
      const holds = balance != null && Number(balance) > 0;
      setTokenNote(
        holds ? `${symbol} added.` : `${symbol} added. It shows here once this wallet holds some.`
      );
      setContract('');
      await refreshAll();
    } catch {
      setTokenError('Could not add that token.');
    } finally {
      setTokenBusy(false);
    }
  }

  async function removeToken(address: string) {
    if (tokenBusy) return;
    setTokenBusy(true);
    setTokenError('');
    setTokenNote('');
    try {
      const res = await fetch('/api/wallet/tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTokenError(body.error || 'Could not remove that token.');
        return;
      }
      setTokenNote('Token removed.');
      await refreshAll();
    } catch {
      setTokenError('Could not remove that token.');
    } finally {
      setTokenBusy(false);
    }
  }

  if (!data) return null;

  const nav = [
    { id: 'balances', label: 'Balances' },
    { id: 'history', label: 'History' },
    { id: 'fund', label: 'Fund' },
    { id: 'power', label: 'Power' },
  ];

  return (
    <AppPage>
      <AppTopBar
        title="Wallet"
        actionLabel={refreshing ? '...' : 'Refresh'}
        onAction={refreshAll}
        actionBusy={refreshing}
      />

      <AppSlideNav items={nav} activeId={slide} onSelect={setSlide} />

      {slide === 'balances' ? (
        <AppSection title="Balances" helper="What this Flizy wallet holds on GIWA Sepolia.">
          <div className="flex items-center">
            {holdings?.holdings?.native ? (
              <p className="font-sans text-3xl tracking-wide text-lime">
                {balancesHidden ? (
                  <span className="tracking-[0.35em] text-muted">••••</span>
                ) : (
                  <>
                    {Number(holdings.holdings.native.balance).toFixed(6)}{' '}
                    <span className="text-lg text-paper">{holdings.holdings.native.symbol}</span>
                  </>
                )}
              </p>
            ) : (
              <p className="font-sans text-2xl text-muted">No balance yet</p>
            )}
            {holdings?.holdings?.native || tokens.length || nfts.length ? (
              <BalanceEye
                hidden={balancesHidden}
                onToggle={() => setBalancesHidden((open) => !open)}
              />
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted">
            {holdings?.holdings?.chain?.name || 'GIWA Sepolia'}
            {Number(data.account.balance_eth || 0) > 0
              ? balancesHidden
                ? ' · Credit ••••'
                : ` · Credit ${data.account.balance_eth}`
              : null}
          </p>

          <div className="mt-5">
            <p className="label">Flizy wallet</p>
            <p className="mono-box mt-1 break-all text-sm">
              {data.account.agent_wallet_address || 'Generating...'}
            </p>
            {data.account.agent_wallet_address ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton value={data.account.agent_wallet_address} label="Copy address" />
                <a
                  className="btn btn-ghost text-sm"
                  href={`${explorerBase}/address/${data.account.agent_wallet_address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Explorer
                </a>
              </div>
            ) : null}
          </div>

          <div className="mt-5">
            <p className="label">Tokens</p>
            {tokens.length ? (
              <ul className="mt-2 space-y-0">
                {tokens.map((t) => {
                  const href = tokenHref(t);
                  const label = (
                    <span className="flex items-center gap-1.5 text-muted">
                      <span>{t.symbol}</span>
                      {t.verified ? <VerifiedMark /> : null}
                    </span>
                  );
                  return (
                    <li
                      key={t.address || t.symbol}
                      className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm first:pt-0 last:border-0 last:pb-0"
                    >
                      {href ? (
                        <Link href={href} className="no-underline">
                          {label}
                        </Link>
                      ) : (
                        label
                      )}
                      <span className="flex items-center gap-2">
                        {t.added && t.address ? (
                          <button
                            type="button"
                            className="min-h-11 px-2 text-xs text-muted"
                            disabled={tokenBusy}
                            onClick={() => removeToken(t.address as string)}
                          >
                            Remove
                          </button>
                        ) : null}
                        <span className="font-mono text-paper">
                          {balancesHidden
                            ? '••••'
                            : t.balance == null
                              ? t.error || 'n/a'
                              : Number(t.balance).toPrecision(6)}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted">
                {holdings?.holdings?.note || 'Tokens appear here once you hold some.'}
              </p>
            )}
            {tokenError ? <p className="alert alert-error mt-3">{tokenError}</p> : null}
            {tokenNote ? <p className="m-0 mt-3 text-xs text-muted">{tokenNote}</p> : null}
            {addingToken ? (
              <form
                className="mt-3 grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  addToken();
                }}
              >
                <label className="grid gap-1">
                  <span className="text-xs leading-relaxed text-muted">
                    Paste a contract. Any token sent to this address can be added. Only a verified token can be sent
                    on socials.
                  </span>
                  <input
                    className="input font-mono"
                    value={contract}
                    spellCheck={false}
                    autoComplete="off"
                    autoFocus
                    aria-label="Token contract"
                    onChange={(event) => setContract(event.target.value)}
                  />
                </label>
                <button type="submit" className="btn btn-primary" disabled={tokenBusy || !contract.trim()}>
                  Add
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="mt-3 inline-flex min-h-11 items-center text-sm text-lime"
                onClick={() => setAddingToken(true)}
              >
                Add a token
              </button>
            )}
          </div>

          <div className="mt-5">
            <p className="label">NFTs</p>
            {nfts.length ? (
              <ul className="mt-2 space-y-0">
                {nfts.map((n) => (
                  <li
                    key={n.address}
                    className="flex items-center justify-between border-b border-border py-2.5 text-sm first:pt-0 last:border-0 last:pb-0"
                  >
                    <span className="text-muted">{n.ticker}</span>
                    <span className="font-mono text-paper">
                      {balancesHidden ? '••••' : n.balance == null ? n.error || 'n/a' : n.balance}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted">Listed NFTs appear after you mint or receive them.</p>
            )}
          </div>
        </AppSection>
      ) : null}

      {/*
        The same panels the History tab renders, from one component, so the two
        surfaces cannot drift. No Wallet link in the empty state here: it would
        point at the page already on screen.
      */}
      {slide === 'history' ? <ActivityPanels showWalletLink={false} /> : null}

      {slide === 'fund' ? (
        <AppSection
          title="Fund"
          helper="Copy your Flizy wallet address, open the official GIWA faucet, paste it, and request test ETH."
        >
          {data.account.agent_wallet_address ? (
            <div className="mb-5">
              <p className="label">Your Flizy wallet (paste this on the faucet)</p>
              <p className="mono-box mt-1 break-all text-sm">{data.account.agent_wallet_address}</p>
              <div className="mt-2">
                <CopyButton value={data.account.agent_wallet_address} label="Copy address" />
              </div>
            </div>
          ) : null}
          <ol className="space-y-3">
            {[
              {
                n: '1',
                t: 'Copy your Flizy wallet address',
                d: 'Use the address above — that is the wallet chat sends leave from.',
              },
              {
                n: '2',
                t: 'Open the official GIWA faucet',
                d: 'Go to faucet.giwa.io (official GIWA testnet faucet).',
                href: 'https://faucet.giwa.io',
                linkLabel: 'Open faucet.giwa.io',
              },
              {
                n: '3',
                t: 'Paste and request funds',
                d: 'Paste your Flizy wallet address on the faucet and claim test ETH. No bridge step.',
                href: 'https://faucet.giwa.io',
                linkLabel: 'Request on faucet',
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
                      target="_blank"
                      rel="noreferrer"
                    >
                      {step.linkLabel} →
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-muted">
            Any token sent to this address is a deposit. Add its contract on Balances so it shows in the wallet.
            Only a verified token can be sent on socials. Any token in the wallet can be traded.
          </p>
        </AppSection>
      ) : null}

      {slide === 'power' ? (
        <AppSection title="Power" helper="Optional crypto tools. Daily money stays in chat.">
          <div className="space-y-0 divide-y divide-border">
            <Link
              href="/dashboard/swap"
              className="flex items-center justify-between py-3 no-underline first:pt-0"
            >
              <div>
                <p className="font-sans text-sm text-paper">Swap</p>
                <p className="mt-0.5 text-xs text-muted">Trade a token from your Flizy wallet</p>
              </div>
              <span className="text-muted" aria-hidden>
                →
              </span>
            </Link>
            <div className="py-3 last:pb-0">
              <p className="font-sans text-sm text-paper">Chat sends</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                <span className="text-paper">flizy send 0.01 to name</span>
                {' · '}
                <span className="text-paper">flizy send 0.01 to @user on github</span>
              </p>
            </div>
          </div>
        </AppSection>
      ) : null}
    </AppPage>
  );
}
