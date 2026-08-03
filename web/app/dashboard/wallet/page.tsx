'use client';

import Link from 'next/link';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppPage, AppSection, AppSectionNav } from '../../../components/AppSection';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';

export default function WalletPage() {
  const { data, holdings, explorerBase, refreshing, refreshAll } = useDashboard();

  if (!data) return null;

  const tokens = holdings?.holdings?.tokens || [];
  const flz = tokens.find((t) => String(t.symbol || '').toUpperCase() === 'FLZ');

  return (
    <AppPage>
      <AppTopBar
        title="Wallet"
        actionLabel={refreshing ? '...' : 'Refresh'}
        onAction={refreshAll}
        actionBusy={refreshing}
      />

      <AppSectionNav
        items={[
          { id: 'balances', label: 'Balances' },
          { id: 'fund', label: 'Fund' },
          { id: 'power', label: 'Power' },
        ]}
      />

      {/* Balances */}
      <AppSection id="balances" title="Balances" helper="What this agent wallet holds on GIWA Sepolia.">
        {holdings?.holdings?.native ? (
          <p className="font-sans text-3xl tracking-wide text-lime">
            {Number(holdings.holdings.native.balance).toFixed(6)}{' '}
            <span className="text-lg text-paper">{holdings.holdings.native.symbol}</span>
          </p>
        ) : (
          <p className="font-sans text-2xl text-muted">No balance yet</p>
        )}
        {flz && flz.balance != null ? (
          <p className="mt-1.5 font-sans text-xl tracking-wide text-paper">
            {Number(flz.balance).toPrecision(6)} <span className="text-base text-muted">FLZ</span>
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted">
          {holdings?.holdings?.chain?.name || 'GIWA Sepolia'}
          {Number(data.account.balance_eth || 0) > 0
            ? ` · Credit ${data.account.balance_eth}`
            : null}
        </p>

        <div className="mt-5">
          <p className="label">Agent wallet</p>
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
              {tokens.map((t) => (
                <li
                  key={t.address || t.symbol}
                  className="flex items-center justify-between border-b border-border py-2.5 text-sm first:pt-0 last:border-0 last:pb-0"
                >
                  <span className="text-muted">{t.symbol}</span>
                  <span className="font-mono text-paper">
                    {t.balance == null ? t.error || 'n/a' : Number(t.balance).toPrecision(6)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted">
              {holdings?.holdings?.note || 'FLZ appears after you buy or receive tokens.'}
            </p>
          )}
        </div>
      </AppSection>

      {/* Fund — primary money-in path */}
      <AppSection
        id="fund"
        title="Fund"
        helper="Faucet and bridge need MetaMask/Rabby. Then send GIWA ETH to your agent address above."
      >
        <ol className="space-y-3">
          {[
            {
              n: '1',
              t: 'Open MetaMask or Rabby',
              d: 'Use a regular browser wallet on Ethereum Sepolia.',
            },
            {
              n: '2',
              t: 'Claim Sepolia ETH',
              d: 'Do not paste your Flizy agent address into the faucet.',
              href: 'https://cloud.google.com/application/web3/faucet',
              linkLabel: 'Google faucet',
            },
            {
              n: '3',
              t: 'Bridge to GIWA Sepolia',
              d: 'Same wallet through the GIWA bridge.',
              href: 'https://bridge-giwa.vercel.app/',
              linkLabel: 'GIWA bridge',
            },
            {
              n: '4',
              t: 'Send to agent wallet',
              d: 'Transfer GIWA ETH to the address in Balances.',
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
      </AppSection>

      {/* Power — crypto optional, secondary placement */}
      <AppSection
        id="power"
        title="Power"
        helper="Optional crypto tools. Daily money stays in chat."
      >
        <div className="space-y-0 divide-y divide-border">
          <Link
            href="/dashboard/swap"
            className="flex items-center justify-between py-3 no-underline first:pt-0"
          >
            <div>
              <p className="font-sans text-sm text-paper">Swap</p>
              <p className="mt-0.5 text-xs text-muted">Buy or sell FLZ from the agent wallet</p>
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
    </AppPage>
  );
}
