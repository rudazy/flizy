'use client';

import { AppTopBar } from '../../../components/AppTopBar';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';

export default function WalletPage() {
  const { data, holdings, explorerBase, refreshing, refreshAll } = useDashboard();

  if (!data) return null;

  return (
    <div className="space-y-5">
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
          {(() => {
            const flz = (holdings?.holdings?.tokens || []).find(
              (t) => String(t.symbol || '').toUpperCase() === 'FLZ'
            );
            if (!flz || flz.balance == null) return null;
            return (
              <p className="mt-1 font-sans text-xl tracking-wide text-paper">
                {Number(flz.balance).toPrecision(6)}{' '}
                <span className="text-base text-muted">FLZ</span>
              </p>
            );
          })()}
          <p className="mt-2 text-xs text-muted">
            Credit: <span className="text-paper">{data.account.balance_eth ?? 0}</span>
            {holdings?.holdings?.chain?.name
              ? ` · ${holdings.holdings.chain.name}`
              : ' · GIWA Sepolia'}
          </p>
        </div>

        <div className="space-y-5 p-4">
          <div>
            <p className="label">Agent wallet</p>
            <p className="mono-box text-sm">
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
            <p className="label">How sending works</p>
            <p className="text-sm leading-relaxed text-muted">
              Sends leave from <span className="text-paper">this agent wallet</span> only via
              WhatsApp, and only to addresses on your trusted list (or a linked peer / claim hold).
              The site never sends to an arbitrary 0x. Fund the wallet, add trusted names under
              Account, then on WhatsApp: <span className="text-paper">flizy send 0.01 to name</span>
              {' · '}
              <span className="text-paper">flizy send 10 FLZ to name</span> → confirm.
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <a
                href="https://cloud.google.com/application/web3/faucet"
                className="btn btn-ghost text-sm"
                target="_blank"
                rel="noreferrer"
              >
                Google faucet
              </a>
              <a
                href="https://bridge-giwa.vercel.app/"
                className="btn btn-ghost text-sm"
                target="_blank"
                rel="noreferrer"
              >
                GIWA bridge
              </a>
            </div>
          </div>

          <div>
            <p className="label">Tokens</p>
            {holdings?.holdings?.tokens?.length ? (
              <ul className="mt-2 space-y-2">
                {holdings.holdings.tokens.map((t) => (
                  <li
                    key={t.address || t.symbol}
                    className="flex items-center justify-between border-b border-border pb-2 text-sm last:border-0"
                  >
                    <span className="text-muted">{t.symbol}</span>
                    <span className="text-paper">
                      {t.balance == null ? t.error || 'n/a' : Number(t.balance).toPrecision(6)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">
                {holdings?.holdings?.note || 'FLZ appears after you buy or receive tokens.'}
              </p>
            )}
          </div>

          <p className="text-xs text-muted">
            WhatsApp: <span className="text-paper">flizy balance</span> shows the same holdings.
          </p>
        </div>
      </section>
    </div>
  );
}
