'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppDesktopTabs } from '../../../components/AppBottomNav';

type Token = 'ETH' | 'FLZ';

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

function fmt(n: string | number, max = 6) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  if (x === 0) return '0';
  if (x >= 1000) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return x.toLocaleString(undefined, { maximumFractionDigits: max });
}

export default function SwapPage() {
  const [tokenIn, setTokenIn] = useState<Token>('ETH');
  const [tokenOut, setTokenOut] = useState<Token>('FLZ');
  const [amountIn, setAmountIn] = useState('0.01');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [price, setPrice] = useState<PriceInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [result, setResult] = useState<{ explorerUrl?: string; txHash?: string } | null>(null);
  const [showLiquidity, setShowLiquidity] = useState(false);
  const [lpEth, setLpEth] = useState('0.05');
  const [lpFlz, setLpFlz] = useState('2500');
  const [lpBase, setLpBase] = useState<'ETH' | 'FLZ'>('ETH');

  const side = tokenIn === 'ETH' ? 'buy' : 'sell';

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
    if (!amountIn || Number(amountIn) <= 0) {
      setQuote(null);
      return;
    }
    setQuoting(true);
    try {
      const q = new URLSearchParams({
        amount: amountIn,
        side,
        tokenIn,
        tokenOut,
      });
      const res = await fetch(`/api/swap/quote?${q}`);
      const data = await res.json();
      if (!res.ok) {
        setQuote(null);
        setError(data.error || 'Quote failed');
        return;
      }
      setQuote(data);
    } catch {
      setQuote(null);
      setError('Quote failed');
    } finally {
      setQuoting(false);
    }
  }, [amountIn, side, tokenIn, tokenOut]);

  useEffect(() => {
    loadPrice();
  }, [loadPrice]);

  useEffect(() => {
    if (showLiquidity) return;
    const t = setTimeout(() => loadQuote(), 320);
    return () => clearTimeout(t);
  }, [loadQuote, showLiquidity]);

  // Keep LP ratio loosely in sync with pool when editing one side
  useEffect(() => {
    if (!price || !showLiquidity) return;
    const flzPerEth = Number(price.flzPerEth);
    if (!(flzPerEth > 0)) return;
    if (lpBase === 'ETH') {
      const eth = Number(lpEth);
      if (eth > 0) setLpFlz(String(Number((eth * flzPerEth).toFixed(4))));
    } else {
      const flz = Number(lpFlz);
      if (flz > 0) setLpEth(String(Number((flz / flzPerEth).toFixed(6))));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only rebalance when pool price loads / base changes
  }, [price?.flzPerEth, showLiquidity, lpBase]);

  function flipTokens() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    // If we had a quoted out, seed the new input with it for a smooth flip
    if (quote?.amountOut) {
      setAmountIn(String(Number(quote.amountOut).toPrecision(8)).replace(/\.?0+$/, '') || quote.amountOut);
    }
    setQuote(null);
    setResult(null);
    setError('');
  }

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
          amount: amountIn,
          tokenIn,
          tokenOut,
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

  const rateLine = useMemo(() => {
    if (!price) return null;
    if (tokenIn === 'ETH') {
      return `1 ETH ≈ ${fmt(price.flzPerEth, 2)} FLZ`;
    }
    return `1 FLZ ≈ ${fmt(price.ethPerFlz, 8)} ETH`;
  }, [price, tokenIn]);

  const ctaLabel = busy
    ? 'Swapping...'
    : !amountIn || Number(amountIn) <= 0
      ? 'Enter an amount'
      : quoting
        ? 'Fetching quote...'
        : !quote
          ? 'Enter an amount'
          : `Swap ${tokenIn} for ${tokenOut}`;

  return (
    <div className="space-y-4">
      <AppTopBar title="Swap" />
      <div className="hidden md:block">
        <AppDesktopTabs />
      </div>

      {/* Header row: title + small liquidity entry */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div>
          <p className="font-sans text-sm tracking-wide text-paper">Trade</p>
          <p className="font-mono text-[11px] text-muted">GIWA Sepolia · ETH / FLZ</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowLiquidity((v) => !v);
            setError('');
            setResult(null);
          }}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11px] text-muted transition-colors hover:border-lime/40 hover:text-lime"
        >
          {showLiquidity ? 'Back to swap' : '+ Liquidity'}
        </button>
      </div>

      {!showLiquidity ? (
        <section className="card overflow-hidden p-3 sm:p-4">
          {/* You pay */}
          <TokenPanel
            label="You pay"
            token={tokenIn}
            amount={amountIn}
            editable
            onAmountChange={(v) => {
              setAmountIn(v);
              setResult(null);
            }}
          />

          {/* Flip */}
          <div className="relative z-10 -my-2.5 flex justify-center">
            <button
              type="button"
              onClick={flipTokens}
              aria-label="Switch tokens"
              className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-ink text-paper shadow-glow transition-transform hover:border-lime/50 hover:text-lime active:scale-95"
            >
              <FlipIcon />
            </button>
          </div>

          {/* You receive */}
          <TokenPanel
            label="You receive"
            token={tokenOut}
            amount={quote ? fmt(quote.amountOut, 6) : quoting ? '…' : '0'}
            editable={false}
            muted={!quote}
          />

          {/* Details */}
          <div className="mt-3 space-y-1.5 rounded-md border border-border/80 bg-ink/50 px-3 py-2.5 font-mono text-[11px]">
            {rateLine ? (
              <div className="flex justify-between gap-2 text-muted">
                <span>Rate</span>
                <span className="text-paper">{rateLine}</span>
              </div>
            ) : null}
            {quote ? (
              <>
                <div className="flex justify-between gap-2 text-muted">
                  <span>Protocol fee</span>
                  <span className="text-gold">
                    {quote.feePct} (~{fmt(quote.fee, 6)} {quote.tokenIn})
                  </span>
                </div>
                <div className="flex justify-between gap-2 text-muted">
                  <span>Slippage</span>
                  <span className="text-paper">{quote.slippagePct}</span>
                </div>
                <div className="flex justify-between gap-2 text-muted">
                  <span>Min received</span>
                  <span className="text-paper">
                    {fmt(quote.amountOutMin, 6)} {quote.tokenOut}
                  </span>
                </div>
                <p className="border-t border-border pt-2 text-[10px] leading-relaxed text-muted">
                  {quote.disclosure}
                </p>
              </>
            ) : (
              <p className="text-muted">Fee is shown here before you confirm. Default protocol fee 0.30%.</p>
            )}
          </div>

          <button
            type="button"
            className="btn btn-primary mt-3 w-full py-3.5 text-base font-semibold"
            disabled={busy || quoting || !quote}
            onClick={runSwap}
          >
            {ctaLabel}
          </button>
        </section>
      ) : (
        <section className="card space-y-3 p-3 sm:p-4">
          <div>
            <p className="font-sans text-sm text-paper">Add liquidity</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Deposit both sides of the ETH / FLZ pool. LP tokens go to your agent wallet. Site only.
              No protocol fee on add (pool still has the standard 0.30% swap fee).
            </p>
          </div>

          {price ? (
            <div className="rounded-md border border-border bg-ink/50 px-3 py-2 font-mono text-[11px] text-muted">
              Pool {fmt(price.reserveWeth, 4)} ETH / {fmt(price.reserveFlz, 0)} FLZ
              <span className="mx-2 text-border">·</span>
              1 ETH ≈ {fmt(price.flzPerEth, 2)} FLZ
            </div>
          ) : null}

          <TokenPanel
            label="ETH"
            token="ETH"
            amount={lpEth}
            editable
            onAmountChange={(v) => {
              setLpBase('ETH');
              setLpEth(v);
              const flzPerEth = Number(price?.flzPerEth || 0);
              if (flzPerEth > 0 && Number(v) > 0) {
                setLpFlz(String(Number((Number(v) * flzPerEth).toFixed(4))));
              }
            }}
          />

          <div className="flex justify-center">
            <span className="font-mono text-xs text-muted">+</span>
          </div>

          <TokenPanel
            label="FLZ"
            token="FLZ"
            amount={lpFlz}
            editable
            onAmountChange={(v) => {
              setLpBase('FLZ');
              setLpFlz(v);
              const flzPerEth = Number(price?.flzPerEth || 0);
              if (flzPerEth > 0 && Number(v) > 0) {
                setLpEth(String(Number((Number(v) / flzPerEth).toFixed(6))));
              }
            }}
          />

          <div className="rounded-md border border-border/80 bg-ink/40 px-3 py-2 font-mono text-[11px] text-muted">
            <div className="flex justify-between gap-2">
              <span>Pair</span>
              <span className="text-paper">ETH / FLZ</span>
            </div>
            <div className="mt-1 flex justify-between gap-2">
              <span>Also shown as</span>
              <span className="text-paper">FLZ / ETH</span>
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary w-full py-3.5 text-base font-semibold"
            disabled={busy || !(Number(lpEth) > 0) || !(Number(lpFlz) > 0)}
            onClick={runLiquidity}
          >
            {busy ? 'Adding...' : 'Supply liquidity'}
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

      <p className="text-center font-mono text-[11px] text-muted">
        WhatsApp: <span className="text-paper">flizy buy 0.01 FLZ</span>
        {' · '}
        <Link href="/dashboard/wallet" className="text-lime no-underline">
          Fund wallet
        </Link>
      </p>
    </div>
  );
}

function TokenPanel({
  label,
  token,
  amount,
  editable,
  muted,
  onAmountChange,
}: {
  label: string;
  token: Token;
  amount: string;
  editable: boolean;
  muted?: boolean;
  onAmountChange?: (v: string) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-surface/80 px-3 py-3 transition-colors focus-within:border-lime/35">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{label}</span>
        <span
          className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-ink px-2.5 py-1 font-sans text-xs font-semibold tracking-wide ${
            token === 'ETH' ? 'text-paper' : 'text-lime'
          }`}
        >
          <TokenDot token={token} />
          {token}
        </span>
      </div>
      {editable ? (
        <input
          className="w-full border-0 bg-transparent p-0 font-mono text-2xl text-paper outline-none placeholder:text-muted/50"
          inputMode="decimal"
          value={amount}
          onChange={(e) => onAmountChange?.(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0"
        />
      ) : (
        <p className={`font-mono text-2xl ${muted ? 'text-muted' : 'text-paper'}`}>{amount}</p>
      )}
    </div>
  );
}

function TokenDot({ token }: { token: Token }) {
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${token === 'ETH' ? 'bg-paper/80' : 'bg-lime'}`}
      aria-hidden
    />
  );
}

function FlipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M12 5l-3.5 3.5M12 5l3.5 3.5M12 19l-3.5-3.5M12 19l3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
