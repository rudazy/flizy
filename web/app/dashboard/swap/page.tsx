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
  poolFeePct?: string;
  allInPct?: string;
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

type Balances = { eth: string; flz: string };

export default function SwapPage() {
  const [tokenIn, setTokenIn] = useState<Token>('ETH');
  const [tokenOut, setTokenOut] = useState<Token>('FLZ');
  const [amountIn, setAmountIn] = useState('0.01');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [price, setPrice] = useState<PriceInfo | null>(null);
  const [balances, setBalances] = useState<Balances>({ eth: '0', flz: '0' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [result, setResult] = useState<{ explorerUrl?: string; txHash?: string } | null>(null);
  const [showLiquidity, setShowLiquidity] = useState(false);
  const [lpMode, setLpMode] = useState<'add' | 'remove'>('add');
  const [lpEth, setLpEth] = useState('0.05');
  const [lpFlz, setLpFlz] = useState('2500');
  const [lpBase, setLpBase] = useState<'ETH' | 'FLZ'>('ETH');
  const [lpPercent, setLpPercent] = useState(100);
  const [lpPosition, setLpPosition] = useState<{
    lpBalanceFormatted: string;
    ethShare: string;
    flzShare: string;
    poolShareBps: number;
  } | null>(null);

  const side = tokenIn === 'ETH' ? 'buy' : 'sell';

  const loadBalances = useCallback(async () => {
    try {
      const res = await fetch('/api/holdings');
      const data = await res.json();
      if (!res.ok) return;
      const eth = data?.holdings?.native?.balance || '0';
      const flzTok = (data?.holdings?.tokens || []).find(
        (t: { symbol?: string }) => String(t.symbol || '').toUpperCase() === 'FLZ'
      );
      setBalances({
        eth: String(eth),
        flz: flzTok?.balance != null ? String(flzTok.balance) : '0',
      });
    } catch {
      /* ignore */
    }
  }, []);

  const balanceFor = useCallback(
    (token: Token) => (token === 'ETH' ? balances.eth : balances.flz),
    [balances]
  );

  function setMaxIn() {
    const raw = balanceFor(tokenIn);
    let n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setAmountIn('0');
      return;
    }
    // Leave a gas buffer when paying with ETH
    if (tokenIn === 'ETH') {
      n = Math.max(0, n - 0.00008);
    }
    const s =
      n >= 1
        ? n.toFixed(6).replace(/\.?0+$/, '')
        : n.toPrecision(6).replace(/\.?0+$/, '');
    setAmountIn(s || '0');
    setResult(null);
  }

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

  const loadLpPosition = useCallback(async () => {
    try {
      const res = await fetch('/api/swap/liquidity');
      const data = await res.json();
      if (!res.ok) {
        setLpPosition(null);
        return;
      }
      setLpPosition({
        lpBalanceFormatted: data.lpBalanceFormatted || '0',
        ethShare: data.ethShare || '0',
        flzShare: data.flzShare || '0',
        poolShareBps: data.poolShareBps || 0,
      });
    } catch {
      setLpPosition(null);
    }
  }, []);

  useEffect(() => {
    loadPrice();
    loadBalances();
  }, [loadPrice, loadBalances]);

  useEffect(() => {
    if (showLiquidity) {
      loadLpPosition();
      return;
    }
    const t = setTimeout(() => loadQuote(), 320);
    return () => clearTimeout(t);
  }, [loadQuote, showLiquidity, loadLpPosition]);

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
      loadBalances();
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
        body: JSON.stringify({
          action: 'add',
          amountEth: lpEth,
          amountToken: lpFlz,
          token: 'FLZ',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Liquidity failed');
        return;
      }
      setResult({ explorerUrl: data.explorerUrl, txHash: data.txHash });
      loadPrice();
      loadLpPosition();
    } catch {
      setError('Liquidity failed');
    } finally {
      setBusy(false);
    }
  }

  async function runRemoveLiquidity(percent = lpPercent) {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/swap/liquidity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', percent }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Remove liquidity failed');
        return;
      }
      setResult({ explorerUrl: data.explorerUrl, txHash: data.txHash });
      loadPrice();
      loadLpPosition();
    } catch {
      setError('Remove liquidity failed');
    } finally {
      setBusy(false);
    }
  }

  const removePreview = useMemo(() => {
    if (!lpPosition) return null;
    const lp = Number(lpPosition.lpBalanceFormatted);
    if (!(lp > 0)) return null;
    const frac = Math.min(100, Math.max(1, lpPercent)) / 100;
    return {
      eth: Number(lpPosition.ethShare) * frac,
      flz: Number(lpPosition.flzShare) * frac,
      lp: lp * frac,
    };
  }, [lpPosition, lpPercent]);

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
            balance={balanceFor(tokenIn)}
            onMax={setMaxIn}
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
            balance={balanceFor(tokenOut)}
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
                  <span>Pool fee</span>
                  <span className="text-paper">{quote.poolFeePct || '0.30%'}</span>
                </div>
                <div className="flex justify-between gap-2 text-muted">
                  <span>All-in</span>
                  <span className="text-lime">{quote.allInPct || '0.60%'} + gas</span>
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
              <p className="text-muted">
                All-in about 0.60% (protocol 0.30% + pool 0.30%) plus network gas. Shown before you
                confirm.
              </p>
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
          <div className="flex gap-1 rounded-md border border-border bg-ink/40 p-1">
            <button
              type="button"
              className={`flex-1 rounded-md py-2 font-sans text-xs font-semibold transition-colors ${
                lpMode === 'add' ? 'bg-lime text-ink' : 'text-muted hover:text-paper'
              }`}
              onClick={() => setLpMode('add')}
            >
              Add
            </button>
            <button
              type="button"
              className={`flex-1 rounded-md py-2 font-sans text-xs font-semibold transition-colors ${
                lpMode === 'remove' ? 'bg-lime text-ink' : 'text-muted hover:text-paper'
              }`}
              onClick={() => {
                setLpMode('remove');
                loadLpPosition();
              }}
            >
              Remove
            </button>
          </div>

          <p className="text-xs leading-relaxed text-muted">
            {lpMode === 'add'
              ? 'Deposit ETH + FLZ. LP tokens go to your agent wallet. Site only. No protocol fee on add.'
              : 'Burn LP tokens to withdraw ETH + FLZ to your agent wallet. Site only. No protocol fee on remove.'}
          </p>

          {price ? (
            <div className="rounded-md border border-border bg-ink/50 px-3 py-2 font-mono text-[11px] text-muted">
              Pool {fmt(price.reserveWeth, 4)} ETH / {fmt(price.reserveFlz, 0)} FLZ
              <span className="mx-2 text-border">·</span>
              1 ETH ≈ {fmt(price.flzPerEth, 2)} FLZ
            </div>
          ) : null}

          {lpMode === 'add' ? (
            <>
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
            </>
          ) : (
            <>
              <div className="rounded-md border border-border bg-surface/80 px-3 py-3 font-mono text-xs">
                <div className="flex justify-between gap-2 text-muted">
                  <span>Your LP</span>
                  <span className="text-paper">
                    {lpPosition ? fmt(lpPosition.lpBalanceFormatted, 6) : '…'} FLZ-LP
                  </span>
                </div>
                <div className="mt-1.5 flex justify-between gap-2 text-muted">
                  <span>Pooled ETH</span>
                  <span className="text-paper">{lpPosition ? fmt(lpPosition.ethShare, 6) : '…'}</span>
                </div>
                <div className="mt-1 flex justify-between gap-2 text-muted">
                  <span>Pooled FLZ</span>
                  <span className="text-paper">{lpPosition ? fmt(lpPosition.flzShare, 4) : '…'}</span>
                </div>
                {lpPosition && lpPosition.poolShareBps > 0 ? (
                  <div className="mt-1 flex justify-between gap-2 text-muted">
                    <span>Pool share</span>
                    <span className="text-paper">{(lpPosition.poolShareBps / 100).toFixed(2)}%</span>
                  </div>
                ) : null}
              </div>

              <div>
                <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-muted">
                  Amount to remove
                </p>
                <div className="grid grid-cols-4 gap-1.5">
                  {[25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setLpPercent(p)}
                      className={`rounded-md border py-2 font-mono text-xs transition-colors ${
                        lpPercent === p
                          ? 'border-lime bg-lime/15 text-lime'
                          : 'border-border text-muted hover:text-paper'
                      }`}
                    >
                      {p === 100 ? 'Max' : `${p}%`}
                    </button>
                  ))}
                </div>
              </div>

              {removePreview ? (
                <div className="rounded-md border border-border/80 bg-ink/50 px-3 py-2.5 font-mono text-[11px] text-muted">
                  <div className="flex justify-between gap-2">
                    <span>You receive (est.)</span>
                    <span className="text-paper">{lpPercent}%</span>
                  </div>
                  <div className="mt-1.5 flex justify-between gap-2">
                    <span>ETH</span>
                    <span className="text-paper">~{fmt(removePreview.eth, 6)}</span>
                  </div>
                  <div className="mt-1 flex justify-between gap-2">
                    <span>FLZ</span>
                    <span className="text-paper">~{fmt(removePreview.flz, 4)}</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted">No LP position yet. Supply liquidity first.</p>
              )}

              <button
                type="button"
                className="btn btn-primary w-full py-3.5 text-base font-semibold"
                disabled={
                  busy ||
                  !lpPosition ||
                  !(Number(lpPosition.lpBalanceFormatted) > 0) ||
                  !(lpPercent > 0)
                }
                onClick={() => runRemoveLiquidity(lpPercent)}
              >
                {busy ? 'Removing...' : `Remove ${lpPercent}% liquidity`}
              </button>
            </>
          )}
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
  balance,
  onMax,
  onAmountChange,
}: {
  label: string;
  token: Token;
  amount: string;
  editable: boolean;
  muted?: boolean;
  balance?: string;
  onMax?: () => void;
  onAmountChange?: (v: string) => void;
}) {
  const balN = balance != null ? Number(balance) : null;
  const balLabel =
    balN == null || !Number.isFinite(balN)
      ? null
      : balN === 0
        ? '0'
        : balN >= 1
          ? balN.toLocaleString(undefined, { maximumFractionDigits: 4 })
          : balN.toPrecision(4);

  return (
    <div className="rounded-md border border-border bg-surface/80 px-3 py-3 transition-colors focus-within:border-lime/35">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{label}</span>
        <div className="flex items-center gap-2">
          {balLabel != null ? (
            <span className="font-mono text-[10px] text-muted">
              Bal {balLabel}
              {editable && onMax ? (
                <button
                  type="button"
                  onClick={onMax}
                  className="ml-1.5 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-lime hover:border-lime/50"
                >
                  Max
                </button>
              ) : null}
            </span>
          ) : null}
          <span
            className={`inline-flex items-center gap-1.5 rounded-md border border-border bg-ink px-2.5 py-1 font-sans text-xs font-semibold tracking-wide ${
              token === 'ETH' ? 'text-paper' : 'text-lime'
            }`}
          >
            <TokenDot token={token} />
            {token}
          </span>
        </div>
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
