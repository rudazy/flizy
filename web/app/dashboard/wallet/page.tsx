'use client';

import Link from 'next/link';
import { AppTopBar } from '../../../components/AppTopBar';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';

export default function WalletPage() {
  const { data, holdings, explorerBase, refreshing, refreshAll } = useDashboard();

  if (!data) return null;

  const tokens = holdings?.holdings?.tokens || [];
  const flz = tokens.find((t) => String(t.symbol || '').toUpperCase() === 'FLZ');

  return (
    <div className="space-y-4">
      <AppTopBar
        title="Wallet"
        actionLabel={refreshing ? '...' : 'Refresh'}
        onAction={refreshAll}
        actionBusy={refreshing}
      />

      <section className="card overflow-hidden">
        <div className="border-b border-border bg-ink/50 px-4 py-5">
          <p className="text-[10px] uppercase tracking-[0.14em] text-muted">On-chain balance</p>
          {holdings?.holdings?.native ? (
            <p className="mt-2 font-sans text-3xl tracking-wide text-lime">
              {Number(holdings.holdings.native.balance).toFixed(6)}{' '}
              <span className="text-lg text-paper">{holdings.holdings.native.symbol}</span>
            </p>
          ) : (
            <p className="mt-2 font-sans text-2xl text-muted">No balance yet</p>
          )}
          {flz && flz.balance != null ? (
            <p className="mt-1.5 font-sans text-xl tracking-wide text-paper">
              {Number(flz.balance).toPrecision(6)}{' '}
              <span className="text-base text-muted">FLZ</span>
            </p>
          ) : null}
          <p className="mt-2 text-xs text-muted">
            {holdings?.holdings?.chain?.name || 'GIWA Sepolia'}
            {Number(data.account.balance_eth || 0) > 0
              ? ` · Credit ${data.account.balance_eth}`
              : null}
          </p>
        </div>

        <div className="space-y-5 p-4">
          <div>
            <p className="label">Agent wallet</p>
            <p className="mono-box text-sm break-all">
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

          <div>
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

          <div className="rounded-md border border-border bg-ink/40 px-3 py-3">
            <p className="text-xs leading-relaxed text-muted">
              Sends leave only via WhatsApp to trusted addresses:{' '}
              <span className="text-paper">flizy send 0.01 to name</span>
              {' · '}
              <span className="text-paper">flizy send 10 FLZ to name</span>.
            </p>
            <Link
              href="/dashboard#fund"
              className="mt-2 inline-block text-xs text-lime no-underline hover:text-gold"
            >
              How to fund this wallet →
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
