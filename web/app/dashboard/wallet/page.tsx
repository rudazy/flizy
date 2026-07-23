'use client';

import { useMemo, useState } from 'react';
import { AppTopBar } from '../../../components/AppTopBar';
import { CopyButton } from '../../../components/CopyButton';
import { useDashboard } from '../../../components/DashboardProvider';

export default function WalletPage() {
  const { data, holdings, explorerBase, refreshing, refreshAll, setMsg, busy, setBusy } =
    useDashboard();
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [asset, setAsset] = useState('ETH');
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<{ explorerUrl?: string } | null>(null);
  const [err, setErr] = useState('');

  const assets = useMemo(() => {
    const list: { id: string; label: string; balance: string }[] = [];
    if (holdings?.holdings?.native) {
      list.push({
        id: 'ETH',
        label: `ETH (${Number(holdings.holdings.native.balance).toFixed(6)})`,
        balance: holdings.holdings.native.balance,
      });
    } else {
      list.push({ id: 'ETH', label: 'ETH', balance: '0' });
    }
    for (const t of holdings?.holdings?.tokens || []) {
      if (!t.symbol) continue;
      list.push({
        id: t.symbol,
        label: `${t.symbol} (${t.balance == null ? '?' : Number(t.balance).toPrecision(6)})`,
        balance: t.balance || '0',
      });
    }
    return list;
  }, [holdings]);

  if (!data) return null;

  async function onWithdraw(e: React.FormEvent) {
    e.preventDefault();
    setErr('');
    setResult(null);
    setBusy('withdraw');
    try {
      const res = await fetch('/api/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset, amount, to, password }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Withdraw failed');
      setResult({ explorerUrl: json.explorerUrl });
      setPassword('');
      setAmount('');
      setMsg(`Withdrawn ${json.amount} ${json.asset}.`);
      await refreshAll();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Withdraw failed');
    } finally {
      setBusy('');
    }
  }

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
              Sends use <span className="text-paper">this agent wallet</span> as From. Fund it, add
              trusted names under Account, then <span className="text-paper">flizy send</span> and
              confirm on WhatsApp.
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

          {/* Tiny emergency withdraw (site-only, password required) */}
          <div className="border-t border-border pt-3">
            <button
              type="button"
              onClick={() => {
                setShowWithdraw((v) => !v);
                setErr('');
                setResult(null);
              }}
              className="text-[10px] font-mono uppercase tracking-wider text-muted underline-offset-2 hover:text-lime hover:underline"
            >
              {showWithdraw ? 'Hide withdraw' : 'Withdraw'}
            </button>

            {showWithdraw ? (
              <form onSubmit={onWithdraw} className="mt-3 space-y-2.5 rounded border border-border bg-ink/50 p-3">
                <p className="text-[11px] leading-relaxed text-muted">
                  Move funds out of the agent wallet if WhatsApp is unavailable. Requires your
                  account password. On-chain and irreversible.
                </p>
                <div>
                  <label className="label">Asset</label>
                  <select
                    className="input"
                    value={asset}
                    onChange={(e) => setAsset(e.target.value)}
                  >
                    {assets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">Amount</label>
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="label">To address</label>
                  <input
                    className="input font-mono text-sm"
                    placeholder="0x..."
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="label">Account password</label>
                  <input
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                {err ? <p className="text-xs text-gold">{err}</p> : null}
                {result?.explorerUrl ? (
                  <a
                    href={result.explorerUrl}
                    className="block break-all text-xs text-lime"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {result.explorerUrl}
                  </a>
                ) : null}
                <button
                  type="submit"
                  className="btn btn-ghost w-full py-2 text-xs"
                  disabled={busy === 'withdraw'}
                >
                  {busy === 'withdraw' ? 'Sending...' : 'Confirm withdraw'}
                </button>
              </form>
            ) : null}
          </div>

          <p className="text-xs text-muted">
            WhatsApp: <span className="text-paper">flizy balance</span> shows the same holdings.
          </p>
        </div>
      </section>
    </div>
  );
}
