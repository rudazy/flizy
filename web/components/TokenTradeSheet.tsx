'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDashboard } from './DashboardProvider';
import { PasswordField } from './PasswordField';
import { formatEthDisplay, maxSpend } from '../lib/tokenFormat';
import { announceTx } from '../lib/txSignal';
import {
  ArrowRightIcon,
  CartIcon,
  CheckIcon,
  CloseIcon,
  EthDiamondIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
  SwapArrowsIcon,
  SwapVerticalIcon,
} from './ExploreIcons';

/**
 * Buy or sell a listed token from its page, in a bottom sheet.
 *
 * What it shows comes from the swap quote (/api/swap/quote) and the pool
 * price the page already holds; nothing is estimated here except the price
 * impact, which is the quote measured against the pool price with the fees
 * taken out. The trade itself is the existing swap, behind the account
 * password, with the quote's minimum as the limit.
 */

type Quote = {
  amountIn: string;
  amountOut: string;
  amountOutMin: string;
  tokenIn: string;
  tokenOut: string;
  slippagePct: string;
  allInBps: number;
  allInPct: string;
  networkFeeEth: string | null;
  disclosure: string;
};

const UP = 'text-[#2fd27a]';
const DOWN = 'text-[#f05252]';
const REQUOTE_MS = 15000;
const MARKS = [0, 25, 50, 75, 100];

function num(v: string | number | null | undefined): number | null {
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : n;
}

function usd(eth: number | null, usdPerEth: number | null): string | null {
  if (eth == null || usdPerEth == null) return null;
  const v = eth * usdPerEth;
  return `≈ $${v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 2 : 0 })}`;
}

/** GIWA gas is often below a millionth of an ETH; say so instead of rounding to 0. */
function feeText(fee: number | null): string {
  if (fee == null) return '-';
  if (fee > 0 && fee < 0.000001) return '< 0.000001 ETH';
  return `${trim(fee, 6)} ETH`;
}

/** Up to `digits` decimals, without trailing zeros. */
function trim(v: number, digits: number): string {
  if (!Number.isFinite(v) || v <= 0) return '0';
  return v.toFixed(digits).replace(/\.?0+$/, '');
}

export function TokenTradeSheet({
  side,
  onSide,
  onClose,
  onTraded,
  symbol,
  logo,
  priceEth,
  change24,
  changeUp,
  usdPerEth,
}: {
  side: 'buy' | 'sell';
  onSide: (side: 'buy' | 'sell') => void;
  onClose: () => void;
  onTraded: () => void;
  symbol: string;
  logo: string | null;
  priceEth: number | null;
  change24: string | null;
  changeUp: boolean;
  usdPerEth: number | null;
}) {
  const titleId = useId();
  const { holdings } = useDashboard();
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState('');
  const [stage, setStage] = useState<'edit' | 'confirm' | 'done'>('edit');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [explorerUrl, setExplorerUrl] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const buying = side === 'buy';
  const payAsset = buying ? 'ETH' : symbol;
  const getAsset = buying ? symbol : 'ETH';
  const ethBalance = holdings?.holdings?.native?.balance ?? null;
  const tokenRow = (holdings?.holdings?.tokens || []).find((t) => String(t.symbol || '').toUpperCase() === symbol.toUpperCase());
  const balance = buying ? ethBalance : tokenRow?.balance ?? null;
  const spendMax = maxSpend(balance, buying);
  const maxNum = num(spendMax) ?? 0;
  const amountNum = num(amount) ?? 0;
  const pct = maxNum > 0 ? Math.max(0, Math.min(100, Math.round((amountNum / maxNum) * 100))) : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [busy, onClose]);

  // A new side starts a new trade.
  useEffect(() => {
    setAmount('');
    setQuote(null);
    setError('');
    setStage('edit');
  }, [side]);

  // Quote a moment after typing stops, and again every 15 s while it is open,
  // so the numbers on screen are the ones the trade will use.
  useEffect(() => {
    if (stage !== 'edit') return;
    setQuote(null);
    if (!amount || !(Number(amount) > 0)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setQuoting(true);
      setError('');
      try {
        const params = new URLSearchParams({ side, amount });
        if (buying) params.set('tokenOut', symbol);
        else params.set('tokenIn', symbol);
        const res = await fetch(`/api/swap/quote?${params.toString()}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error || 'Could not quote that amount.');
          return;
        }
        setQuote(body as Quote);
      } catch {
        if (!cancelled) setError('Could not quote that amount.');
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // A cancelled request never reaches its finally, so clear the flag here.
      setQuoting(false);
    };
  }, [side, amount, symbol, buying, stage, tick]);

  useEffect(() => {
    if (stage !== 'edit' || !amount) return;
    const t = window.setInterval(() => setTick((n) => n + 1), REQUOTE_MS);
    return () => window.clearInterval(t);
  }, [stage, amount]);

  const setByPercent = useCallback(
    (p: number) => {
      if (maxNum <= 0) return;
      setAmount(p >= 100 ? String(spendMax) : trim((maxNum * p) / 100, buying ? 6 : 4));
    },
    [maxNum, spendMax, buying]
  );

  const quoteReady = quote != null && Math.abs(Number(quote.amountIn) - amountNum) <= amountNum * 1e-9;
  const outNum = quoteReady ? num(quote.amountOut) : null;
  const minNum = quoteReady ? num(quote.amountOutMin) : null;
  const feeNum = quoteReady ? num(quote.networkFeeEth) : null;

  // The pool price says what this amount would buy with no move at all; the
  // gap to the quote, once the fees are taken out, is the price impact.
  let impact: number | null = null;
  if (quoteReady && priceEth && outNum != null && amountNum > 0) {
    const afterFees = amountNum * (1 - quote.allInBps / 10000);
    const atSpot = buying ? afterFees / priceEth : afterFees * priceEth;
    impact = atSpot > 0 ? Math.max(0, (1 - outNum / atSpot) * 100) : null;
  }
  const impactTone = impact == null ? '' : impact < 1 ? UP : impact < 3 ? 'text-[#e0a85a]' : DOWN;
  const impactWord = impact == null ? '' : impact < 1 ? 'Low' : impact < 3 ? 'Medium' : 'High';

  const payEth = buying ? amountNum : priceEth ? amountNum * priceEth : null;
  const getEth = outNum == null ? null : buying ? (priceEth ? outNum * priceEth : null) : outNum;

  async function confirm() {
    if (!quoteReady || busy || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/swap/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side,
          amount,
          tokenIn: buying ? 'ETH' : symbol,
          tokenOut: buying ? symbol : 'ETH',
          minOut: quote?.amountOutMin,
          password,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'The trade did not go through.');
        return;
      }
      setExplorerUrl(typeof body.explorerUrl === 'string' ? body.explorerUrl : null);
      setPassword('');
      setStage('done');
      announceTx();
      onTraded();
    } catch {
      setError('The trade did not go through.');
    } finally {
      setBusy(false);
    }
  }

  const logoBox = (size: string, text: string) =>
    logo ? (
      <img src={logo} alt="" className={`${size} shrink-0 rounded-[14px] border border-sun/40 object-cover`} />
    ) : (
      <span className={`${size} flex shrink-0 items-center justify-center rounded-[14px] border border-sun/40 bg-[#0b0b0b] font-sans font-bold text-sun ${text}`} aria-hidden>
        {symbol.slice(0, 1)}.
      </span>
    );

  const ethMark = (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#161616] text-[#e6e6e6]">
      <EthDiamondIcon size={22} />
    </span>
  );

  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/75 backdrop-blur-[3px] sm:items-center sm:p-4" role="presentation" onClick={() => !busy && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[94dvh] w-full max-w-[460px] flex-col overflow-hidden rounded-t-[24px] border border-b-0 border-[#2c2416] bg-[#0c0c0c] shadow-[0_-24px_70px_rgba(0,0,0,0.65)] sm:rounded-[24px] sm:border-b"
        style={{ background: 'radial-gradient(90% 40% at 80% 0%, rgba(70,50,16,0.55) 0%, rgba(12,12,12,0) 70%), #0c0c0c' }}
      >
        <div className="overflow-y-auto px-4 pb-4 pt-3 sm:px-5">
          <div className="mx-auto h-1 w-10 rounded-full bg-[#3a3a3a]" aria-hidden />
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#141414] text-[#e6e6e6]"
            aria-label="Close"
          >
            <CloseIcon size={16} />
          </button>

          {/* Header */}
          <div className="mt-3 flex items-center gap-3.5 pr-12">
            {logoBox('h-12 w-12', 'text-xl')}
            <div className="min-w-0">
              <h2 id={titleId} className="m-0 font-sans text-[22px] font-bold leading-tight text-[#f5f5f5]">
                {buying ? 'Buy' : 'Sell'} <span className="text-sun">{symbol}</span>
              </h2>
              <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[13px] text-[#a9a9a9]">
                <span className="rounded-[6px] bg-[#1c1c1c] px-1.5 py-0.5 text-[11px] font-semibold text-[#e6e6e6]">GIWA</span>
                {priceEth ? <span>{formatEthDisplay(priceEth, 6)} ETH</span> : null}
                {change24 ? <span className={changeUp ? UP : DOWN}>{change24}</span> : null}
              </p>
            </div>
          </div>

          {stage === 'done' ? (
            <div className="mt-6 grid justify-items-center gap-3 pb-2 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full border border-[#2fd27a]/50 bg-[#2fd27a]/10 text-[#2fd27a]">
                <CheckIcon size={26} />
              </span>
              <p className="m-0 font-sans text-xl font-semibold text-[#f5f5f5]">Trade sent</p>
              <p className="m-0 text-sm text-[#a9a9a9]">
                {buying ? 'Bought' : 'Sold'} with {trim(amountNum, 6)} {payAsset}. Your balance updates in a moment.
              </p>
              {explorerUrl ? (
                <a href={explorerUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-sm text-sun no-underline">
                  View transaction <ExternalLinkIcon size={13} />
                </a>
              ) : null}
              <button type="button" onClick={onClose} className="hit-y-44 mt-2 h-12 w-full rounded-[12px] border border-[#383838] font-sans text-base text-[#f5f5f5]">
                Done
              </button>
            </div>
          ) : (
            <>
              <p className="m-0 mt-3 text-[13px] text-[#a9a9a9]">
                {buying ? `Swap ETH for ${symbol}` : `Swap ${symbol} for ETH`} from your Flizy wallet, priced from the GIWA pool.
              </p>

              {/* Buy / Sell */}
              <div className="mt-4 grid grid-cols-2 gap-1 rounded-[14px] border border-[#262626] bg-[#111] p-1" role="tablist" aria-label="Buy or sell">
                {(['buy', 'sell'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={side === s}
                    onClick={() => onSide(s)}
                    disabled={stage === 'confirm'}
                    className={`hit-y-44 flex h-11 items-center justify-center gap-2 rounded-[11px] font-sans text-[15px] font-semibold transition-colors ${
                      side === s ? 'bg-sun text-sun-ink shadow-[0_6px_20px_rgba(247,208,71,0.25)]' : 'text-[#cfcfcf]'
                    }`}
                  >
                    {s === 'buy' ? <CartIcon size={18} /> : <SwapArrowsIcon size={18} className={side === s ? '' : DOWN} />}
                    {s === 'buy' ? `Buy ${symbol}` : `Sell ${symbol}`}
                  </button>
                ))}
              </div>

              {stage === 'edit' ? (
                <>
                  {/* You pay */}
                  <section className="relative mt-3 rounded-[16px] border border-sun/25 bg-[#101010] p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="m-0 font-sans text-sm font-semibold text-[#f5f5f5]">You pay</p>
                      <p className="m-0 flex items-center gap-2 font-mono text-xs text-[#a9a9a9]">
                        <span className="truncate">
                          Balance: {balance == null ? '-' : `${trim(Number(balance), buying ? 6 : 4)} ${payAsset}`}
                        </span>
                        <button
                          type="button"
                          onClick={() => setByPercent(100)}
                          disabled={maxNum <= 0}
                          className="hit-y-44 h-7 rounded-full border border-sun/50 px-2.5 font-sans text-xs font-semibold text-sun disabled:opacity-40"
                        >
                          Max
                        </button>
                      </p>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      {buying ? ethMark : logoBox('h-10 w-10', 'text-base')}
                      <div className="min-w-0">
                        <p className="m-0 font-sans text-base font-semibold text-[#f5f5f5]">{payAsset}</p>
                        <p className="m-0 font-mono text-xs text-[#8f8f8f]">GIWA</p>
                      </div>
                      <div className="ml-auto min-w-0 text-right">
                        <label className="sr-only" htmlFor="trade-amount">
                          Amount in {payAsset}
                        </label>
                        <input
                          id="trade-amount"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value.replace(',', '.').replace(/[^\d.]/g, ''))}
                          className="w-full min-w-0 bg-transparent text-right font-mono text-[24px] font-semibold text-[#f5f5f5] outline-none placeholder:text-[#555]"
                        />
                        <p className="m-0 font-mono text-xs text-[#8f8f8f]">{usd(payEth, usdPerEth) ?? ' '}</p>
                      </div>
                    </div>

                    {/* Share of balance */}
                    <div className="mt-5">
                      <div className="relative">
                        <span
                          className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded-[6px] bg-sun px-1.5 py-0.5 font-mono text-[11px] font-bold text-sun-ink"
                          style={{ left: `${pct}%` }}
                          aria-hidden
                        >
                          {pct}%
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={1}
                          value={pct}
                          disabled={maxNum <= 0}
                          onChange={(e) => setByPercent(Number(e.target.value))}
                          aria-label="Share of your balance"
                          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-[#262626] accent-sun disabled:opacity-40"
                          style={{ background: `linear-gradient(90deg, #f7d047 ${pct}%, #262626 ${pct}%)` }}
                        />
                      </div>
                      <div className="mt-1.5 flex justify-between">
                        {MARKS.map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setByPercent(m)}
                            disabled={maxNum <= 0}
                            className={`hit-y-44 font-mono text-xs ${pct >= m ? 'text-[#e6e6e6]' : 'text-[#7a7a7a]'}`}
                          >
                            {m}%
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>

                  {/* Flip */}
                  <div className="relative z-10 -my-3 flex justify-center">
                    <button
                      type="button"
                      onClick={() => onSide(buying ? 'sell' : 'buy')}
                      className="hit-y-44 flex h-11 w-11 items-center justify-center rounded-full border border-sun/50 bg-[#141008] text-sun"
                      aria-label={buying ? `Switch to selling ${symbol}` : `Switch to buying ${symbol}`}
                    >
                      <SwapVerticalIcon size={18} />
                    </button>
                  </div>

                  {/* You receive */}
                  <section
                    className="rounded-[16px] border border-[#2fd27a]/30 p-3.5"
                    style={{ background: 'linear-gradient(160deg, rgba(47,210,122,0.10) 0%, rgba(16,16,16,1) 60%)' }}
                  >
                    <p className="m-0 font-sans text-sm font-semibold text-[#f5f5f5]">You receive (est.)</p>
                    <div className="mt-3 flex items-center gap-3">
                      {buying ? logoBox('h-10 w-10', 'text-base') : ethMark}
                      <p className="m-0 font-sans text-base font-semibold text-[#f5f5f5]">{getAsset}</p>
                      <div className="ml-auto min-w-0 text-right">
                        <p className="m-0 truncate font-mono text-[24px] font-semibold text-[#f5f5f5]">
                          {quoting && !quoteReady ? '...' : outNum != null ? trim(outNum, buying ? 2 : 6) : '0'}
                        </p>
                        <p className="m-0 font-mono text-xs text-[#a9a9a9]">{usd(getEth, usdPerEth) ?? ' '}</p>
                      </div>
                    </div>
                  </section>

                  {/* Figures */}
                  <section className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-[#232323] bg-[#232323]">
                    <Figure label={`Price (1 ${symbol})`} value={priceEth ? `${formatEthDisplay(priceEth, 6)} ETH` : '-'} sub={usd(priceEth, usdPerEth)} />
                    <Figure
                      label="Price impact"
                      value={<span className={impactTone}>{impact == null ? '-' : `${impact.toFixed(2)}%`}</span>}
                      sub={impact == null ? null : <span className={impactTone}>{impactWord}</span>}
                    />
                    <Figure label="Network fee (est.)" value={feeText(feeNum)} sub={usd(feeNum, usdPerEth)} />
                    {buying ? (
                      <Figure
                        label="Total cost (est.)"
                        value={quoteReady ? `${trim(amountNum + (feeNum ?? 0), 6)} ETH` : '-'}
                        sub={quoteReady ? usd(amountNum + (feeNum ?? 0), usdPerEth) : null}
                      />
                    ) : (
                      <Figure label="You get at least" value={minNum == null ? '-' : `${trim(minNum, 6)} ETH`} sub={usd(minNum, usdPerEth)} />
                    )}
                  </section>

                  {/* Rate */}
                  <div className="mt-3 flex items-center gap-3 rounded-[14px] border border-[#232323] bg-[#101010] px-3.5 py-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[#2e2e2e] text-[#cfcfcf]">
                      <SwapArrowsIcon size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="m-0 font-mono text-sm text-[#f0f0f0]">
                        {priceEth ? (buying ? `1 ETH ≈ ${trim(1 / priceEth, 1)} ${symbol}` : `1 ${symbol} ≈ ${formatEthDisplay(priceEth, 6)} ETH`) : '-'}
                      </p>
                      <p className="m-0 text-xs text-[#8f8f8f]">
                        Priced from the GIWA pool{quoteReady ? ` · slippage limit ${quote.slippagePct}` : ''}
                      </p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#2fd27a]/35 bg-[#2fd27a]/10 px-2.5 py-1 font-sans text-xs font-semibold text-[#2fd27a]">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#2fd27a]" aria-hidden />
                      Live quote
                    </span>
                  </div>

                  {error ? (
                    <p className="m-0 mt-3 text-sm text-[#e0b070]" role="alert">
                      {error}
                    </p>
                  ) : null}
                </>
              ) : (
                /* Confirm */
                <section className="mt-3 grid gap-3 rounded-[16px] border border-[#232323] bg-[#101010] p-4">
                  <Line label="You pay" value={`${trim(amountNum, 6)} ${payAsset}`} />
                  <Line label="You receive (est.)" value={`${outNum == null ? '-' : trim(outNum, buying ? 2 : 6)} ${getAsset}`} />
                  <Line label="You get at least" value={`${minNum == null ? '-' : trim(minNum, buying ? 2 : 6)} ${getAsset}`} />
                  <Line label="Fees" value={quoteReady ? `${quote.allInPct} + network fee` : '-'} />
                  <p className="m-0 text-xs leading-relaxed text-[#8f8f8f]">
                    This sends from your Flizy wallet. If the price moves past your limit, the trade does not go through and nothing is spent but network gas.
                  </p>
                  <PasswordField label="Account password" value={password} onChange={setPassword} autoComplete="current-password" />
                  {error ? (
                    <p className="m-0 text-sm text-[#e0b070]" role="alert">
                      {error}
                    </p>
                  ) : null}
                </section>
              )}
            </>
          )}
        </div>

        {stage !== 'done' ? (
          <div className="border-t border-[#1c1c1c] bg-[#0c0c0c]/95 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 sm:px-5">
            {stage === 'edit' ? (
              <button
                type="button"
                disabled={!quoteReady || quoting}
                onClick={() => setStage('confirm')}
                className="hit-y-44 flex h-12 w-full items-center justify-center gap-2 rounded-[12px] bg-sun font-sans text-base font-bold text-sun-ink shadow-[0_10px_30px_rgba(247,208,71,0.25)] transition-opacity disabled:opacity-40"
              >
                {buying ? 'Review buy' : 'Review sell'} <ArrowRightIcon size={18} />
              </button>
            ) : (
              <div className="grid grid-cols-[auto_1fr] gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPassword('');
                    setStage('edit');
                  }}
                  disabled={busy}
                  className="hit-y-44 h-12 rounded-[12px] border border-[#383838] px-5 font-sans text-base text-[#f5f5f5]"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => void confirm()}
                  disabled={busy || !password}
                  className="hit-y-44 h-12 rounded-[12px] bg-sun font-sans text-base font-bold text-sun-ink transition-opacity disabled:opacity-40"
                >
                  {busy ? 'Sending...' : buying ? 'Confirm buy' : 'Confirm sell'}
                </button>
              </div>
            )}
            <p className="m-0 mt-3 flex items-center gap-2 text-xs text-[#8f8f8f]">
              <ShieldCheckIcon size={15} className="shrink-0 text-[#2fd27a]" />
              Sent from your Flizy wallet only after your account password.
            </p>
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

function Figure({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-[#101010] px-3 py-2.5">
      <p className="m-0 truncate font-sans text-[11px] text-[#8f8f8f]">{label}</p>
      <p className="m-0 mt-0.5 truncate font-mono text-[13px] font-semibold text-[#f0f0f0]">{value}</p>
      {sub ? <p className="m-0 truncate font-mono text-[11px] text-[#8f8f8f]">{sub}</p> : null}
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#1c1c1c] pb-2.5 last:border-0">
      <span className="text-sm text-[#a9a9a9]">{label}</span>
      <span className="font-mono text-sm text-[#f0f0f0]">{value}</span>
    </div>
  );
}
