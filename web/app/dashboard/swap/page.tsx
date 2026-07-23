'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppDesktopTabs } from '../../../components/AppBottomNav';

type Quote = {
  amountIn: string;
  amountOut: string;
  amountOutMin: string;
  fee: string;
  feeBps: number;
  feePct: string;
  slippagePct: string;
  tokenIn: string;
  tokenOut: string;
  disclosure: string;
  chain: { id: number; name: string };
};

type PriceInfo = {
  flzPerEth: string;
  ethPerFlz: string;
  reserveFlz: string;
  reserveWeth: string;
};

export default function SwapPage() {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.01');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [price, setPrice] = useState<PriceInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ explorerUrl?: string; txHash?: string } | null>(null);
  const [tab, setTab] = useState<'swap' | 'liquidity'>('swap');
  const [lpEth, setLpEth] = useState('0.05');
  const [lpFlz, setLpFlz] = useState('2500');

  const loadPrice = useCallback(async () => {
    try {
      const res = await fetch('/api/swap/quote?price=1');
      const data = await res.json();
      if (data.price) setPrice(data.price);
    } catch {
      /* ignore */
    }
  }, []);

  const loadQuote = useCallback(async () => {
    setError('');
    setQuote(null);
    if (!amount || Number(amount) <= 0) return;
    try {
      const q = new URLSearchParams({
        amount,
        side,
        tokenIn: side === 'sell' ? 'FLZ' : 'ETH',
        tokenOut: side === 'buy' ? 'FLZ' : 'ETH',
      });
      const res = await fetch(`/api/swap/quote?${q}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Quote failed');
        return;
      }
      setQuote(data);
    } catch {
      setError('Quote failed');
    }
  }, [amount, side]);

  useEffect(() => {
    loadPrice();
  }, [loadPrice]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (tab === 'swap') loadQuote();
    }, 350);
    return () => clearTimeout(t);
  }, [loadQuote, tab]);

  async function runSwap() {
    setBusy(true);
    setError('');
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
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Swap failed');
        return;
      }
      setResult({ explorerUrl: data.explorerUrl, txHash: data.txHash });
      loadPrice();
      loadQuote();
    } catch {
      setError('Swap failed');
    } finally {
      setBusy(false);
    }
  }

  async function runLiquidity() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/swap/liquidity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountEth: lpEth, amountToken: lpFlz, token: 'FLZ' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Liquidity failed');
        return;
      }
      setResult({ explorerUrl: data.explorerUrl, txHash: data.txHash });
      loadPrice();
    } catch {
      setError('Liquidity failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <AppTopBar title="Swap" />
      <div className="hidden md:block">
        <AppDesktopTabs />
      </div>

      <div className="flex gap-2 rounded-md border border-border bg-surface/50 p-1">
        <button
          type="button"
          className={`flex-1 rounded-md py-2.5 font-sans text-sm font-medium transition-colors ${
            tab === 'swap' ? 'bg-lime text-ink' : 'text-muted hover:text-paper'
          }`}
          onClick={() => setTab('swap')}
        >
          Swap
        </button>
        <button
          type="button"
          className={`flex-1 rounded-md py-2.5 font-sans text-sm font-medium transition-colors ${
            tab === 'liquidity' ? 'bg-lime text-ink' : 'text-muted hover:text-paper'
          }`}
          onClick={() => setTab('liquidity')}
        >
          Liquidity
        </button>
      </div>

      {price ? (
        <div className="card px-4 py-3 font-mono text-xs text-muted">
          <span className="text-paper">1 ETH</span> ≈ {Number(price.flzPerEth).toLocaleString(undefined, { maximumFractionDigits: 2 })} FLZ
          <span className="mx-2 text-border">|</span>
          Pool {Number(price.reserveWeth).toFixed(3)} ETH / {Number(price.reserveFlz).toLocaleString(undefined, { maximumFractionDigits: 0 })} FLZ
        </div>
      ) : null}

      {tab === 'swap' ? (
        <section className="card space-y-4 p-4 sm:p-5">
          <div className="flex gap-2">
            <button
              type="button"
              className={`flex-1 rounded-md border py-3 font-sans text-sm font-semibold transition-colors ${
                side === 'buy'
                  ? 'border-lime bg-lime/15 text-lime'
                  : 'border-border text-muted hover:text-paper'
              }`}
              onClick={() => setSide('buy')}
            >
              Buy FLZ
            </button>
            <button
              type="button"
              className={`flex-1 rounded-md border py-3 font-sans text-sm font-semibold transition-colors ${
                side === 'sell'
                  ? 'border-lime bg-lime/15 text-lime'
                  : 'border-border text-muted hover:text-paper'
              }`}
              onClick={() => setSide('sell')}
            >
              Sell FLZ
            </button>
          </div>

          <label className="block space-y-1.5">
            <span className="font-mono text-xs uppercase tracking-wide text-muted">
              You pay ({side === 'buy' ? 'ETH' : 'FLZ'})
            </span>
            <input
              className="w-full rounded-md border border-border bg-ink px-4 py-3.5 font-mono text-lg text-paper outline-none focus:border-lime/50"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
            />
          </label>

          {quote ? (
            <div className="space-y-2 rounded-md border border-border bg-ink/60 px-4 py-3 font-mono text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted">You receive</span>
                <span className="text-paper">
                  ~{Number(quote.amountOut).toLocaleString(undefined, { maximumFractionDigits: 6 })}{' '}
                  {quote.tokenOut}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted">Protocol fee</span>
                <span className="text-gold">
                  {quote.feePct} (~{Number(quote.fee).toLocaleString(undefined, { maximumFractionDigits: 6 })}{' '}
                  {quote.tokenIn})
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted">Slippage</span>
                <span className="text-paper">{quote.slippagePct}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted">Chain</span>
                <span className="text-paper">{quote.chain.name}</span>
              </div>
              <p className="border-t border-border pt-2 text-xs leading-relaxed text-muted">
                {quote.disclosure}
              </p>
            </div>
          ) : null}

          <button
            type="button"
            className="btn btn-primary w-full py-3.5 text-base font-semibold"
            disabled={busy || !quote}
            onClick={runSwap}
          >
            {busy ? 'Swapping...' : `Confirm ${side === 'buy' ? 'buy' : 'sell'}`}
          </button>
        </section>
      ) : (
        <section className="card space-y-4 p-4 sm:p-5">
          <p className="text-sm leading-relaxed text-muted">
            Add liquidity on the site only (not available on WhatsApp). LP tokens go to your agent wallet.
            No protocol fee on add; the pool still uses standard Uniswap V2 0.30% swap fee.
          </p>
          <label className="block space-y-1.5">
            <span className="font-mono text-xs uppercase tracking-wide text-muted">ETH amount</span>
            <input
              className="w-full rounded-md border border-border bg-ink px-4 py-3 font-mono text-paper outline-none focus:border-lime/50"
              value={lpEth}
              onChange={(e) => setLpEth(e.target.value)}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="font-mono text-xs uppercase tracking-wide text-muted">FLZ amount</span>
            <input
              className="w-full rounded-md border border-border bg-ink px-4 py-3 font-mono text-paper outline-none focus:border-lime/50"
              value={lpFlz}
              onChange={(e) => setLpFlz(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-primary w-full py-3.5 text-base font-semibold"
            disabled={busy}
            onClick={runLiquidity}
          >
            {busy ? 'Adding...' : 'Add liquidity'}
          </button>
        </section>
      )}

      {error ? <div className="alert alert-warn text-sm">{error}</div> : null}
      {result?.explorerUrl ? (
        <div className="alert alert-ok space-y-1 text-sm">
          <p>Confirmed on-chain.</p>
          <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="break-all">
            {result.explorerUrl}
          </a>
        </div>
      ) : null}

      <p className="text-center font-mono text-xs text-muted">
        WhatsApp: <span className="text-paper">flizy buy 0.01 FLZ</span>
        {' · '}
        <Link href="/dashboard/wallet" className="text-lime no-underline">
          Fund wallet
        </Link>
      </p>
    </div>
  );
}
