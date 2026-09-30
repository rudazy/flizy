'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AppPage } from './AppSection';
import { AppTopBar } from './AppTopBar';
import { useDashboard } from './DashboardProvider';
import { maxSpend } from '../lib/tokenFormat';
import { PasswordField } from './PasswordField';

type Held = {
  address: string;
  symbol: string;
  decimals: number;
  balance: string | null;
  verified: false;
  chainName: string;
  explorerBaseUrl: string;
};

type Quote = {
  amountIn: string;
  amountOut: string;
  amountOutMin: string;
  tokenIn: string;
  tokenOut: string;
  slippagePct: string;
  allInPct: string;
  disclosure: string;
};

function sameAmount(left: string, right: string): boolean {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return false;
  return Math.abs(a - b) <= a * 1e-9;
}

/**
 * A token this wallet holds that Flizy has not verified.
 * It can be bought and sold. It cannot be sent on socials, and it has no
 * pool chart: a figure here would be invented.
 */
export function HeldToken({ address }: { address: string }) {
  const router = useRouter();
  const { holdings, refreshAll } = useDashboard();
  const [held, setHeld] = useState<Held | null>(null);
  const [loadError, setLoadError] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stage, setStage] = useState<'edit' | 'confirm'>('edit');
  const [busy, setBusy] = useState(false);
  const [tradeError, setTradeError] = useState('');
  const [result, setResult] = useState<{ explorerUrl?: string } | null>(null);
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await fetch(`/api/tokens/${address}`);
      const body = await res.json().catch(() => ({}));
      if (body.listedSymbol === 'flz') {
        router.replace('/dashboard/explore/tokens/flz');
        return;
      }
      if (!res.ok) {
        setHeld(null);
        setLoadError(body.error || 'Could not load this token.');
        return;
      }
      setHeld(body.held as Held);
    } catch {
      setLoadError('Could not load this token.');
    }
  }, [address, router]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!held) return;
    setQuote(null);
    setStage('edit');
    if (!amount || Number(amount) <= 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setQuoting(true);
      setTradeError('');
      try {
        const params = new URLSearchParams({ side, amount });
        if (side === 'buy') params.set('tokenOut', held.address);
        else params.set('tokenIn', held.address);
        const res = await fetch(`/api/swap/quote?${params.toString()}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setQuote(null);
          setTradeError(body.error || 'Could not quote that amount.');
          return;
        }
        setQuote(body as Quote);
      } catch {
        if (!cancelled) setTradeError('Could not quote that amount.');
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [held, side, amount]);

  if (!held) {
    return (
      <AppPage>
        <AppTopBar title="Token" />
        <div className="grid w-full max-w-lg gap-3">
          <p className="m-0 text-sm text-muted">{loadError || 'Loading...'}</p>
          <Link href="/dashboard/wallet" className="text-sm text-lime no-underline">
            Wallet
          </Link>
        </div>
      </AppPage>
    );
  }

  const ethBalance = holdings?.holdings?.native?.balance ?? null;
  const balance = side === 'buy' ? ethBalance : held.balance;
  const spendMax = maxSpend(balance, side === 'buy');
  const quoteReady = quote != null && sameAmount(quote.amountIn, amount);
  const unit = side === 'buy' ? 'ETH' : held.symbol;

  async function confirmTrade() {
    if (!held || !quote || !quoteReady || busy || !password) return;
    setBusy(true);
    setTradeError('');
    setResult(null);
    try {
      const res = await fetch('/api/swap/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side,
          amount,
          tokenIn: side === 'sell' ? held.address : 'ETH',
          tokenOut: side === 'buy' ? held.address : 'ETH',
          minOut: quote.amountOutMin,
          password,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTradeError(body.error || 'The trade did not go through.');
        return;
      }
      setResult({ explorerUrl: body.explorerUrl });
      setStage('edit');
      setPassword('');
      setAmount('');
      setQuote(null);
      load();
      refreshAll();
    } catch {
      setTradeError('The trade did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppPage>
      <AppTopBar title={held.symbol} />
      <div className="grid w-full max-w-lg gap-4">
        <Link href="/dashboard/wallet" className="text-xs text-muted no-underline">
          Wallet
        </Link>
        <div>
          <p className="m-0 font-sans text-lg tracking-wide text-paper">{held.symbol}</p>
          <p className="m-0 text-sm text-muted">Not verified. It cannot be sent on socials.</p>
          <p className="m-0 text-sm text-muted">It can be traded from this wallet.</p>
          <p className="m-0 text-sm text-muted">
            Anyone can create a token and its pool, and pull the pool later. Only trade tokens you
            know.
          </p>
          <p className="m-0 mt-1 break-all font-mono text-xs text-muted">{held.address}</p>
          <a
            className="text-xs text-lime"
            href={`${held.explorerBaseUrl}/address/${held.address}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Token contract
          </a>
        </div>

        <section className="card grid gap-3 p-4">
          <p className="m-0 font-sans text-sm tracking-wide text-paper">Trade</p>
          <div className="grid grid-cols-2 gap-1 rounded-md border border-border p-1" role="tablist" aria-label="Buy or sell">
            {(['buy', 'sell'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={side === item}
                onClick={() => {
                  setSide(item);
                  setStage('edit');
                  setResult(null);
                }}
                className={`min-h-11 rounded-md font-sans text-sm uppercase tracking-wide ${
                  side === item ? 'bg-lime/10 text-lime' : 'text-muted'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
          <label className="grid gap-1">
            <span className="label">Amount ({unit})</span>
            <input
              className="input font-mono"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setStage('edit');
                setResult(null);
              }}
            />
          </label>
          <div className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>
              Balance {balance == null ? 'unavailable' : `${balance} ${unit}`}
            </span>
            <button
              type="button"
              className="min-h-11 px-2 text-lime"
              disabled={spendMax == null}
              onClick={() => {
                if (spendMax != null) setAmount(spendMax);
                setStage('edit');
              }}
            >
              Max
            </button>
          </div>
          {quoteReady ? (
            <div className="grid gap-1 font-mono text-[11px] text-muted">
              <div className="flex justify-between gap-2">
                <span>You receive</span>
                <span className="text-paper">
                  {quote.amountOut} {quote.tokenOut}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Minimum</span>
                <span className="text-paper">
                  {quote.amountOutMin} {quote.tokenOut}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span>Slippage</span>
                <span className="text-paper">{quote.slippagePct}</span>
              </div>
              <p className="m-0 leading-relaxed">{quote.disclosure}</p>
            </div>
          ) : null}
          {quoting ? <p className="m-0 text-xs text-muted">Quoting...</p> : null}
          {tradeError ? <p className="alert alert-error">{tradeError}</p> : null}
          {result?.explorerUrl ? (
            <a className="text-sm text-lime" href={result.explorerUrl} target="_blank" rel="noreferrer noopener">
              Trade sent. View it.
            </a>
          ) : null}
          {stage === 'edit' ? (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!quoteReady || quoting}
              onClick={() => setStage('confirm')}
            >
              {side === 'buy' ? 'Review buy' : 'Review sell'}
            </button>
          ) : (
            <div className="grid gap-2">
              <p className="m-0 text-sm text-paper">
                {side === 'buy' ? 'Buy' : 'Sell'} {amount}{' '}
                {side === 'buy' ? `ETH of ${held.symbol}` : `${held.symbol} for ETH`}. This sends from your Flizy
                wallet.
              </p>
              <PasswordField
                label="Account password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                hint="Needed for tokens Flizy has not verified."
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !password}
                onClick={confirmTrade}
              >
                {busy ? 'Sending...' : 'Confirm transaction'}
              </button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setStage('edit')}>
                Back
              </button>
            </div>
          )}
        </section>
      </div>
    </AppPage>
  );
}
