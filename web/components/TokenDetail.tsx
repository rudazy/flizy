'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppPage } from './AppSection';
import { AppTopBar } from './AppTopBar';
import { useDashboard } from './DashboardProvider';
import { formatEthDisplay, formatPct, maxSpend } from '../lib/tokenFormat';
import { VerifiedMark } from './VerifiedMark';
import { PasswordField } from './PasswordField';
import type { HolderView } from '../lib/tokenHolders';

type Market = {
  symbol: string;
  name: string;
  address: string;
  pair: string;
  chainName: string;
  explorerBaseUrl: string;
  priceEth: string | null;
  marketCapEth: string | null;
  liquidityEth: string | null;
  change1hPct: number | null;
  volumeEth: string | null;
  trades: number | null;
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

function eth(raw: string | null | undefined): string {
  const text = formatEthDisplay(raw ?? null);
  return text == null ? 'unavailable' : `${text} ETH`;
}

function sameAmount(left: string, right: string): boolean {
  const a = Number(left);
  const b = Number(right);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return false;
  return Math.abs(a - b) <= a * 1e-9;
}

function shortAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * One listed token: the pool figures and the trade.
 * Buy and sell use the existing swap. Slippage shown here is the one the
 * quote will apply. It is not a control, because the swap route sets it.
 */
export function TokenDetail({ symbol }: { symbol: string }) {
  const listed = symbol.toLowerCase() === 'flz';
  const { holdings, refreshAll } = useDashboard();
  const [market, setMarket] = useState<Market | null>(null);
  const [marketError, setMarketError] = useState('');
  const [holdersOpen, setHoldersOpen] = useState(false);
  const [holderRows, setHolderRows] = useState<HolderView[] | null>(null);
  const [topShare, setTopShare] = useState<string | null>(null);
  const [holderCount, setHolderCount] = useState<number | null>(null);
  const [holderError, setHolderError] = useState('');
  const [holdersBusy, setHoldersBusy] = useState(false);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [stage, setStage] = useState<'edit' | 'confirm'>('edit');
  const [busy, setBusy] = useState(false);
  const [tradeError, setTradeError] = useState('');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<{ explorerUrl?: string } | null>(null);

  const loadMarket = useCallback(async () => {
    setMarketError('');
    try {
      const res = await fetch('/api/tokens/flz');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMarketError(body.error || 'Could not load this token.');
        return;
      }
      setMarket(body.market as Market);
    } catch {
      setMarketError('Could not load this token.');
    }
  }, []);

  useEffect(() => {
    if (!listed) return;
    loadMarket();
  }, [listed, loadMarket]);

  useEffect(() => {
    if (!listed) return;
    setQuote(null);
    setStage('edit');
    if (!amount || Number(amount) <= 0) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setQuoting(true);
      setTradeError('');
      try {
        const params = new URLSearchParams({ side, amount });
        if (side === 'buy') params.set('tokenOut', 'FLZ');
        else params.set('tokenIn', 'FLZ');
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
  }, [listed, side, amount]);

  if (!listed) {
    return (
      <AppPage>
        <AppTopBar title="Token" />
        <div className="grid w-full max-w-lg gap-3">
          <p className="m-0 text-sm text-muted">This token is not listed.</p>
          <Link href="/dashboard/explore?s=tokens" className="text-sm text-lime no-underline">
            Tokens
          </Link>
        </div>
      </AppPage>
    );
  }

  const ethBalance = holdings?.holdings?.native?.balance ?? null;
  const flzRow = (holdings?.holdings?.tokens || []).find(
    (token) => String(token.symbol || '').toUpperCase() === 'FLZ'
  );
  const balance = side === 'buy' ? ethBalance : flzRow?.balance ?? null;
  const spendMax = maxSpend(balance, side === 'buy');
  const change = formatPct(market?.change1hPct ?? null);
  const quoteReady = quote != null && sameAmount(quote.amountIn, amount);
  const stats = [
    ['Market cap', eth(market?.marketCapEth)],
    ['Volume, 1h', eth(market?.volumeEth)],
    ['Liquidity', eth(market?.liquidityEth)],
    ['Price', eth(market?.priceEth)],
    ['Price change', change ? `${change} 1h` : 'unavailable'],
    ['Holders', holderCount == null ? 'unavailable' : String(holderCount)],
    ['Trades, 1h', market?.trades == null ? 'unavailable' : String(market.trades)],
  ];

  async function confirmTrade() {
    if (!quoteReady || busy || !password) return;
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
          tokenIn: side === 'sell' ? 'FLZ' : 'ETH',
          tokenOut: side === 'buy' ? 'FLZ' : 'ETH',
          minOut: quote?.amountOutMin,
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
      loadMarket();
      refreshAll();
    } catch {
      setTradeError('The trade did not go through.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleHolders() {
    const next = !holdersOpen;
    setHoldersOpen(next);
    if (!next || holderRows || holdersBusy) return;
    setHoldersBusy(true);
    setHolderError('');
    try {
      const res = await fetch('/api/tokens/flz/holders');
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.holders) {
        setHolderError('Holders could not be read.');
        return;
      }
      const rows = Array.isArray(body.holders.holders) ? body.holders.holders : [];
      setHolderRows(
        rows
          .filter(
            (row: HolderView) =>
              row && typeof row.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(row.address) && typeof row.amount === 'string'
          )
          .slice(0, 10)
          .map((row: HolderView) => ({
            address: row.address,
            amount: row.amount,
            label: row.label === 'Pool' ? 'Pool' : null,
          }))
      );
      setTopShare(typeof body.holders.topShare === 'string' ? body.holders.topShare : null);
      setHolderCount(typeof body.holders.count === 'number' ? body.holders.count : null);
    } catch {
      setHolderError('Holders could not be read.');
    } finally {
      setHoldersBusy(false);
    }
  }

  return (
    <AppPage>
      <AppTopBar title={market?.symbol || 'FLZ'} />
      <div className="grid w-full max-w-lg gap-4">
        <Link href="/dashboard/explore?s=tokens" className="text-xs text-muted no-underline">
          Tokens
        </Link>

        <div>
          <p className="m-0 flex items-center gap-1.5 font-sans text-lg tracking-wide text-paper">
            <span>{market?.name || 'FLZ'}</span>
            <VerifiedMark />
          </p>
          <p className="m-0 text-xs text-muted">Verified. It can be sent on socials.</p>
          <p className="m-0 font-mono text-2xl text-paper">{eth(market?.priceEth)}</p>
          <p className={`m-0 font-mono text-sm ${change && change.startsWith('+') ? 'text-lime' : 'text-muted'}`}>
            {change ? `${change} 1h` : '1h unavailable'}
          </p>
          <p className="m-0 mt-1 text-sm text-muted">Market cap {eth(market?.marketCapEth)}</p>
          <p className="m-0 text-xs text-muted">Priced from the ETH pool.</p>
          {market ? (
            <p className="m-0 mt-2 flex gap-4 text-xs">
              <a
                className="text-lime no-underline"
                href={`${market.explorerBaseUrl}/address/${market.address}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Contract
              </a>
              <a
                className="text-lime no-underline"
                href={`${market.explorerBaseUrl}/address/${market.pair}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                Pool
              </a>
            </p>
          ) : null}
        </div>

        {marketError ? <p className="alert alert-error">{marketError}</p> : null}

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
            <span className="label">Amount ({side === 'buy' ? 'ETH' : 'FLZ'})</span>
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
            <span>Balance {balance == null ? 'unavailable' : `${balance} ${side === 'buy' ? 'ETH' : 'FLZ'}`}</span>
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
              <div className="flex justify-between gap-2">
                <span>All-in</span>
                <span className="text-paper">{quote.allInPct}</span>
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
                {side === 'buy' ? 'Buy' : 'Sell'} {amount} {side === 'buy' ? 'ETH of FLZ' : 'FLZ for ETH'}. This
                sends from your Flizy wallet.
              </p>
              <PasswordField
                label="Account password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
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

        <section className="card grid grid-cols-2 gap-3 p-4">
          {stats.map(([label, value]) => (
            <div key={label}>
              <p className="m-0 text-[11px] uppercase tracking-wide text-muted">{label}</p>
              <p className="m-0 font-mono text-sm text-paper">{value}</p>
            </div>
          ))}
        </section>

        <section className="card p-4">
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-between text-left"
            aria-expanded={holdersOpen}
            onClick={toggleHolders}
          >
            <span className="font-sans text-sm tracking-wide text-paper">Holders</span>
            <span className="font-mono text-[11px] text-muted">{holdersOpen ? 'Close' : 'Top 10'}</span>
          </button>
          {holdersOpen ? (
            <div className="mt-2 border-t border-border pt-3">
              {holdersBusy ? <p className="m-0 text-sm text-muted">Reading holders...</p> : null}
              {holderError ? <p className="alert alert-error">{holderError}</p> : null}
              {holderRows && !holderError ? (
                <>
                  <p className="m-0 text-sm text-paper">
                    {holderRows.length === 0
                      ? 'No holders were read.'
                      : topShare
                        ? `Top ${holderRows.length} hold ${topShare}`
                        : 'Top share could not be read.'}
                  </p>
                  <ol className="m-0 mt-2 list-none p-0">
                    {holderRows.map((row, index) => (
                      <li key={row.address} className="border-b border-border py-2.5 last:border-0">
                        <a
                          className="flex min-w-0 items-baseline gap-3 no-underline"
                          href={
                            market
                              ? `${market.explorerBaseUrl}/address/${row.address}`
                              : undefined
                          }
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          <span className="w-4 shrink-0 font-mono text-[11px] text-muted">{index + 1}</span>
                          <span className="min-w-0 truncate font-mono text-sm text-paper">
                            {row.label ? `${row.label} ${shortAddress(row.address)}` : shortAddress(row.address)}
                          </span>
                        </a>
                        <p className="m-0 pl-7 font-mono text-xs text-muted">{row.amount} FLZ</p>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </AppPage>
  );
}
