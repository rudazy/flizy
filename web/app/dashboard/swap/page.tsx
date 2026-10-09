'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppPage } from '../../../components/AppSection';
import { formatAmount } from '../../../lib/amountDisplay';
import { pairFromQuery, SWAP_ASSETS, type SwapToken } from '../../../lib/swapPair';
import { LISTED_TOKENS, listedBySymbol } from '../../../lib/listedTokens';
import { announceTx } from '../../../lib/txSignal';
import {
  ArrowRightIcon,
  ChartLineIcon,
  ChevronDownIcon,
  EthDiamondIcon,
  GearIcon,
  InfoIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  ShieldCheckIcon,
  SwapArrowsIcon,
  SwapVerticalIcon,
} from '../../../components/ExploreIcons';

type Token = SwapToken;
type Mode = 'swap' | 'limit' | 'liquidity';

type Quote = {
  amountIn: string;
  amountOut: string;
  amountOutMin: string;
  slippagePct: string;
  tokenIn: string;
  tokenOut: string;
};

/** One ETH pool's spot price, for the token named by symbol. */
type PriceInfo = {
  symbol: string;
  tokenPerEth: string;
  ethPerToken: string;
  reserveToken: string;
  reserveWeth: string;
};

type LimitOrder = {
  id: string;
  tokenIn: Token;
  tokenOut: Token;
  amountIn: string;
  minOut: string;
  status: 'open' | 'filling' | 'filled' | 'cancelled' | 'expired' | 'failed';
  expiresAt: string;
  txHash: string | null;
  error: string | null;
};

/** Wallet balances by symbol: ETH, FLZ and each listed token. */
type Balances = Record<string, string>;

/** The name under a symbol in the token picker. */
function tokenName(token: Token): string {
  if (token === 'ETH') return 'Ethereum';
  if (token === 'FLZ') return 'Flizy';
  return listedBySymbol(token)?.name ?? token;
}

/** Characters kept out of the source as literals; see the ASCII rule for this repo. */
const APPROX = String.fromCharCode(0x2248);
const DOT = String.fromCharCode(0xb7);

/** How often the quote and pool price refresh while the page is open. */
const QUOTE_REFRESH_MS = 10000;

/** Slippage the screen may set, matching SLIPPAGE_BPS_MIN/MAX in lib/swapGate.ts. */
const SLIPPAGE_MIN_PCT = 0.1;
const SLIPPAGE_MAX_PCT = 5;

/**
 * With no cap this is the shared money rule (lib/amountDisplay.js), so a swap
 * amount reads the same here as it does in chat. With a cap it is a rate or a
 * percentage, where fewer digits is the point, and the locale is pinned so
 * grouping does not depend on who is reading.
 */
function fmt(n: string | number, max?: number) {
  if (max === undefined) return formatAmount(n);
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  if (x === 0) return '0';
  return x.toLocaleString('en-US', { maximumFractionDigits: max });
}

/** A typed number with no more digits than the token can hold, as a plain string. */
function plain(n: number, digits = 6): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  return (n >= 1 ? n.toFixed(digits) : n.toPrecision(digits)).replace(/\.?0+$/, '');
}

export default function SwapPage() {
  const [mode, setMode] = useState<Mode>('swap');
  // A Trade button elsewhere opens this screen on its pair: ?from=FLZ&to=ETH or
  // ?from=ETH&to=IZY. Anything else falls back to buying FLZ.
  const search = useSearchParams();
  const linked = pairFromQuery(search.get('from'), search.get('to'));
  const [tokenIn, setTokenIn] = useState<Token>(linked.tokenIn);
  const [tokenOut, setTokenOut] = useState<Token>(linked.tokenOut);
  const [amountIn, setAmountIn] = useState('0.01');
  const [quoted, setQuote] = useState<(Quote & { inputs: string }) | null>(null);
  const [priceInfo, setPrice] = useState<PriceInfo | null>(null);
  const [balances, setBalances] = useState<Balances>({});
  const [slippagePct, setSlippagePct] = useState('1.00');
  const [editingSlippage, setEditingSlippage] = useState(false);
  const [limitPrice, setLimitPrice] = useState('');
  const [editingLimit, setEditingLimit] = useState(false);
  const [orders, setOrders] = useState<LimitOrder[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [result, setResult] = useState<{ explorerUrl?: string; note?: string } | null>(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [lpMode, setLpMode] = useState<'add' | 'remove'>('add');
  const [lpEth, setLpEth] = useState('0.05');
  const [lpFlz, setLpFlz] = useState('2500');
  const [lpPercent, setLpPercent] = useState(100);
  const [lpPosition, setLpPosition] = useState<{
    lpBalanceFormatted: string;
    ethShare: string;
    flzShare: string;
    poolShareBps: number;
  } | null>(null);

  const side = tokenIn === 'ETH' ? 'buy' : 'sell';
  /** Every pool is against ETH: the other side is the token being traded. */
  const asset = tokenIn === 'ETH' ? tokenOut : tokenIn;
  // A price read for another token is not this pair's price.
  const price = priceInfo && priceInfo.symbol === asset ? priceInfo : null;
  const slippageBps = Math.round(Number(slippagePct) * 100);

  // A quote request that has been overtaken must not overwrite a newer one.
  const quoteSeq = useRef(0);

  // A quote counts only for the inputs it was made for. Once the amount, the
  // pair or the slippage changes it is gone from the screen and Swap waits for
  // a fresh one, so the figures shown and the minimum sent always match.
  const inputs = `${amountIn}|${tokenIn}|${tokenOut}|${slippageBps}`;
  const quote = quoted && quoted.inputs === inputs ? quoted : null;

  const loadBalances = useCallback(async () => {
    try {
      const res = await fetch('/api/holdings');
      const data = await res.json();
      if (!res.ok) return;
      const rows: Array<{ symbol?: string; address?: string | null; balance?: string | null }> = data?.holdings?.tokens || [];
      const next: Balances = { ETH: String(data?.holdings?.native?.balance || '0') };
      const flzTok = rows.find((t) => String(t.symbol || '').toUpperCase() === 'FLZ');
      next.FLZ = flzTok?.balance != null ? String(flzTok.balance) : '0';
      // Listed tokens are matched by contract, so a look-alike symbol someone
      // added by hand cannot stand in for one.
      for (const listed of LISTED_TOKENS) {
        const row = rows.find((t) => String(t.address || '').toLowerCase() === listed.address.toLowerCase());
        next[listed.symbol] = row?.balance != null ? String(row.balance) : '0';
      }
      setBalances(next);
    } catch {
      /* balances stay as they were */
    }
  }, []);

  const loadPrice = useCallback(async () => {
    try {
      const res = await fetch(`/api/swap/quote?price=1&token=${encodeURIComponent(asset)}`);
      const data = await res.json();
      if (data.price) setPrice(data.price);
    } catch {
      /* the rate row waits for the next refresh */
    }
  }, [asset]);

  const loadQuote = useCallback(async () => {
    const seq = ++quoteSeq.current;
    if (!amountIn || !(Number(amountIn) > 0)) {
      setQuote(null);
      return;
    }
    setQuoting(true);
    try {
      const q = new URLSearchParams({ amount: amountIn, side, tokenIn, tokenOut, slippageBps: String(slippageBps) });
      const res = await fetch(`/api/swap/quote?${q}`);
      const data = await res.json();
      if (seq !== quoteSeq.current) return;
      if (!res.ok) {
        setQuote(null);
        setError(data.error || 'Quote failed');
        return;
      }
      setError('');
      setQuote({ ...data, inputs: `${amountIn}|${tokenIn}|${tokenOut}|${slippageBps}` });
    } catch {
      if (seq === quoteSeq.current) {
        setQuote(null);
        setError('Quote failed');
      }
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
  }, [amountIn, side, tokenIn, tokenOut, slippageBps]);

  const loadOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/swap/limit');
      const data = await res.json();
      if (res.ok) setOrders(data.orders || []);
    } catch {
      /* the list waits for the next refresh */
    }
  }, []);

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
    loadOrders();
  }, [loadPrice, loadBalances, loadOrders]);

  // The quote follows the inputs, and refreshes on its own while the page is
  // open, so the figure on screen is the pool as it is now.
  useEffect(() => {
    if (mode !== 'swap') return;
    const first = setTimeout(() => loadQuote(), 320);
    const every = setInterval(() => {
      if (!busy) {
        loadQuote();
        loadPrice();
      }
    }, QUOTE_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [mode, loadQuote, loadPrice, busy]);

  // Limit mode keeps the market rate and the order list current.
  useEffect(() => {
    if (mode !== 'limit') return;
    const every = setInterval(() => {
      loadPrice();
      loadOrders();
    }, QUOTE_REFRESH_MS);
    return () => clearInterval(every);
  }, [mode, loadPrice, loadOrders]);

  useEffect(() => {
    if (mode === 'liquidity') loadLpPosition();
  }, [mode, loadLpPosition]);

  /** One whole in-token buys this many out-tokens at the pool's spot price. */
  const marketRate = useMemo(() => {
    if (!price) return null;
    const r = Number(tokenIn === 'ETH' ? price.tokenPerEth : price.ethPerToken);
    return Number.isFinite(r) && r > 0 ? r : null;
  }, [price, tokenIn]);

  // Start the limit price at the market rate whenever the pair turns round or
  // the rate first arrives, so the field never opens on a stale direction.
  useEffect(() => {
    if (mode === 'limit' && marketRate && !limitPrice) setLimitPrice(plain(marketRate, 8));
  }, [mode, marketRate, limitPrice]);

  const balanceFor = (token: Token) => balances[token] ?? '0';

  function setMaxIn() {
    let n = Number(balanceFor(tokenIn));
    if (!Number.isFinite(n) || n <= 0) {
      setAmountIn('0');
      return;
    }
    // Leave a gas buffer when paying with ETH.
    if (tokenIn === 'ETH') n = Math.max(0, n - 0.00008);
    setAmountIn(plain(n) || '0');
    setResult(null);
  }

  function flipTokens() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    if (mode === 'swap' && quote?.amountOut) setAmountIn(plain(Number(quote.amountOut), 8) || amountIn);
    setQuote(null);
    setLimitPrice('');
    setResult(null);
    setError('');
  }

  function chooseToken(which: 'in' | 'out', token: Token) {
    const current = which === 'in' ? tokenIn : tokenOut;
    const other = which === 'in' ? tokenOut : tokenIn;
    if (token === current) return;
    // ETH, or the token already on the other side, turns the pair round.
    if (token === 'ETH' || token === other) {
      flipTokens();
      return;
    }
    // Another token takes this side, and the other side is always ETH.
    if (which === 'in') {
      setTokenIn(token);
      setTokenOut('ETH');
    } else {
      setTokenOut(token);
      setTokenIn('ETH');
    }
    setQuote(null);
    setLimitPrice('');
    setResult(null);
    setError('');
  }

  /** Limit orders and liquidity are for the FLZ pool only, so those modes trade FLZ. */
  function changeMode(next: Mode) {
    if (next !== 'swap' && asset !== 'FLZ') {
      if (tokenIn === 'ETH') setTokenOut('FLZ');
      else setTokenIn('FLZ');
      setQuote(null);
      setLimitPrice('');
    }
    setMode(next);
  }

  function commitSlippage(raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < SLIPPAGE_MIN_PCT || n > SLIPPAGE_MAX_PCT) {
      setError(`Slippage must be between ${SLIPPAGE_MIN_PCT}% and ${SLIPPAGE_MAX_PCT}%.`);
      return;
    }
    setError('');
    setSlippagePct(n.toFixed(2));
    setEditingSlippage(false);
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
          password,
          slippageBps,
          // The minimum on screen. The server refuses a fill below it.
          minOut: quote?.amountOutMin,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Swap failed');
        return;
      }
      setResult({ explorerUrl: data.explorerUrl });
      setPassword('');
      loadPrice();
      loadQuote();
      loadBalances();
      announceTx();
    } catch {
      setError('Swap failed');
    } finally {
      setBusy(false);
    }
  }

  async function placeOrder() {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/swap/limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'place', side, amount: amountIn, price: limitPrice, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not place the order.');
        return;
      }
      setResult({ note: 'Limit order placed. It fills when the pool reaches your price.' });
      setPassword('');
      loadOrders();
    } catch {
      setError('Could not place the order.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelOrder(id: string) {
    setError('');
    try {
      const res = await fetch('/api/swap/limit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', id }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Could not cancel the order.');
      loadOrders();
    } catch {
      setError('Could not cancel the order.');
    }
  }

  async function runLiquidity(body: Record<string, unknown>, failed: string) {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/swap/liquidity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || failed);
        return;
      }
      setResult({ explorerUrl: data.explorerUrl });
      setPassword('');
      loadPrice();
      loadLpPosition();
      loadBalances();
      announceTx();
    } catch {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  // What the out side is worth against the pool's spot price: the fees and the
  // trade's own impact together, which is what the person gives up.
  const costPct = useMemo(() => {
    if (!quote || !marketRate) return null;
    const ideal = Number(amountIn) * marketRate;
    const got = Number(quote.amountOut);
    if (!(ideal > 0) || !Number.isFinite(got)) return null;
    return (got / ideal - 1) * 100;
  }, [quote, marketRate, amountIn]);

  /** A token figure's worth in ETH at spot, for the line under it. */
  function ethValueOf(token: Token, amount: number): string | null {
    if (token === 'ETH' || !price || !(amount > 0)) return null;
    return `${APPROX} ${fmt(amount * Number(price.ethPerToken), 6)} ETH`;
  }

  const limitOut = useMemo(() => {
    const a = Number(amountIn);
    const p = Number(limitPrice);
    return a > 0 && p > 0 ? a * p : 0;
  }, [amountIn, limitPrice]);

  const limitVsMarket = marketRate && Number(limitPrice) > 0 ? (Number(limitPrice) / marketRate - 1) * 100 : null;

  const swapCta = busy
    ? 'Swapping...'
    : !(Number(amountIn) > 0)
      ? 'Enter an amount'
      : !quote
        ? 'Fetching quote...'
        : `Swap ${tokenIn} for ${tokenOut}`;

  const tradeTitle = mode === 'limit' ? 'Limit order' : 'Trade';
  /** The tokens either picker offers: every pool on Swap, the FLZ pool on Limit. */
  const pickable: Token[] = mode === 'swap' ? ['ETH', ...SWAP_ASSETS] : ['ETH', 'FLZ'];

  return (
    <AppPage>
      <AppTopBar title="Swap" />

      <div className="!-mt-[17px] flex items-stretch gap-[10.5px]">
        <div className="flex h-[36px] flex-1 rounded-[5px] border border-chrome-line bg-[#0e0f11]" role="tablist" aria-label="Trade type">
          <ModeTab active={mode === 'swap'} onClick={() => changeMode('swap')} icon={<SwapArrowsIcon size={15} />} label="Swap" />
          <ModeTab active={mode === 'limit'} onClick={() => changeMode('limit')} icon={<ChartLineIcon size={15} />} label="Limit" />
        </div>
        <button
          type="button"
          onClick={() => changeMode(mode === 'liquidity' ? 'swap' : 'liquidity')}
          aria-pressed={mode === 'liquidity'}
          className={`hit-y-44 flex h-[33px] w-[104px] shrink-0 items-center justify-center gap-[9px] self-center rounded-[5px] border border-sun font-sans text-[9.8px] font-medium text-sun ${
            mode === 'liquidity' ? 'bg-sun-wash' : 'bg-transparent'
          }`}
        >
          <PlusIcon size={11} strokeWidth={2} />
          Add liquidity
        </button>
      </div>

      {mode !== 'liquidity' ? (
        <>
          <section
            className="rounded-[6px] border border-[#3a3017] px-[11.5px] pb-[13px] pt-[12px]"
            style={{ background: 'linear-gradient(180deg, #13110b 0%, #0e0d0b 100%)' }}
          >
            <div className="mb-[9px] flex items-start justify-between">
              <div>
                <h2 className="m-0 font-sans text-[13.5px] font-semibold leading-[17px] text-white">{tradeTitle}</h2>
                <p className="m-0 mt-[1px] font-sans text-[10px] text-[#9d9d9d]">
                  GIWA Sepolia {DOT} ETH / {asset}
                </p>
              </div>
              {mode === 'swap' ? (
                <button
                  type="button"
                  onClick={() => setEditingSlippage((v) => !v)}
                  aria-label="Slippage settings"
                  aria-pressed={editingSlippage}
                  className="hit-44 flex h-[28px] w-[28px] items-center justify-center rounded-[5px] border border-[#2a2b30] bg-[#0f0f10] text-[#e6e6e6] hover:text-white"
                >
                  <GearIcon size={14} />
                </button>
              ) : null}
            </div>

            <TokenPanel
              label="From"
              token={tokenIn}
              balance={balanceFor(tokenIn)}
              onMax={setMaxIn}
              options={pickable}
              onToken={(t) => chooseToken('in', t)}
              amount={
                <input
                  aria-label={`Amount of ${tokenIn}`}
                  className="w-full bg-transparent text-right font-sans text-[20px] font-semibold text-white outline-none placeholder:text-[#5c5c60]"
                  inputMode="decimal"
                  value={amountIn}
                  placeholder="0"
                  onChange={(e) => {
                    setAmountIn(e.target.value.replace(/[^0-9.]/g, ''));
                    setResult(null);
                  }}
                />
              }
              sub={ethValueOf(tokenIn, Number(amountIn))}
            />

            <div className="relative z-10 -my-[10px] flex justify-center">
              <button
                type="button"
                onClick={flipTokens}
                aria-label="Switch tokens"
                className="flex h-[34px] w-[34px] items-center justify-center rounded-full border-[1.5px] border-sun bg-[#0f0d07] text-sun"
              >
                <SwapVerticalIcon size={16} />
              </button>
            </div>

            <TokenPanel
              label="To"
              token={tokenOut}
              balance={balanceFor(tokenOut)}
              options={pickable}
              onToken={(t) => chooseToken('out', t)}
              amount={
                <span className={`block truncate text-right font-sans text-[20px] font-semibold ${quote || mode === 'limit' ? 'text-white' : 'text-[#5c5c60]'}`}>
                  {mode === 'limit'
                    ? limitOut
                      ? fmt(limitOut, 6)
                      : '0'
                    : quote
                      ? fmt(quote.amountOut, 6)
                      : Number(amountIn) > 0
                        ? '...'
                        : '0'}
                </span>
              }
              sub={
                mode === 'limit' ? (
                  'At your price'
                ) : quote ? (
                  <>
                    {ethValueOf(tokenOut, Number(quote.amountOut))}
                    {costPct != null ? (
                      <span className={costPct < 0 ? 'text-[#f05252]' : 'text-[#2fd27a]'}>
                        {' '}
                        ({costPct >= 0 ? '+' : ''}
                        {costPct.toFixed(1)}%)
                      </span>
                    ) : null}
                  </>
                ) : null
              }
            />
          </section>

          <section className="!mt-[10px] rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[18px]">
            {mode === 'swap' ? (
              <>
                <DetailRow
                  label="Rate"
                  info="The pool's price right now, before fees."
                  value={marketRate ? `1 ${tokenIn} ${APPROX} ${fmt(marketRate, tokenIn === 'ETH' ? 2 : 8)} ${tokenOut}` : '...'}
                  action={
                    <IconAction label="Refresh the quote" onClick={() => { loadPrice(); loadQuote(); }}>
                      <RefreshIcon size={15} className={quoting ? 'animate-spin' : undefined} />
                    </IconAction>
                  }
                />
                <DetailRow
                  label="Slippage"
                  info="How far the price may move before the swap is refused."
                  value={
                    editingSlippage ? (
                      <InlineNumber
                        initial={slippagePct}
                        suffix="%"
                        label="Slippage percent"
                        onCommit={commitSlippage}
                        onCancel={() => setEditingSlippage(false)}
                      />
                    ) : (
                      `${slippagePct}%`
                    )
                  }
                  action={
                    <IconAction label="Edit slippage" onClick={() => setEditingSlippage((v) => !v)}>
                      <PencilIcon size={14} />
                    </IconAction>
                  }
                />
                <DetailRow
                  label="Min received"
                  info="The least this swap can return. Below this it does not go through."
                  value={quote ? `${fmt(quote.amountOutMin, 6)} ${quote.tokenOut}` : '...'}
                  sub={quote ? ethValueOf(tokenOut, Number(quote.amountOutMin)) : null}
                  last
                />
              </>
            ) : (
              <>
                <DetailRow
                  label="Limit price"
                  info="Your order fills only when the pool gives at least this much."
                  value={
                    editingLimit ? (
                      <InlineNumber
                        initial={limitPrice}
                        prefix={`1 ${tokenIn} =`}
                        suffix={tokenOut}
                        label="Limit price"
                        onLive={setLimitPrice}
                        onCommit={(v) => {
                          if (Number(v) > 0) {
                            setLimitPrice(v);
                            setEditingLimit(false);
                          }
                        }}
                        onCancel={() => setEditingLimit(false)}
                      />
                    ) : (
                      `1 ${tokenIn} = ${limitPrice ? fmt(limitPrice, tokenIn === 'ETH' ? 2 : 8) : '...'} ${tokenOut}`
                    )
                  }
                  sub={
                    limitVsMarket != null ? (
                      <span className={limitVsMarket < 0 ? 'text-[#f05252]' : 'text-[#2fd27a]'}>
                        {limitVsMarket >= 0 ? '+' : ''}
                        {limitVsMarket.toFixed(2)}% vs market
                      </span>
                    ) : null
                  }
                  action={
                    <IconAction label="Edit limit price" onClick={() => setEditingLimit((v) => !v)}>
                      <PencilIcon size={14} />
                    </IconAction>
                  }
                />
                <DetailRow
                  label="Market"
                  info="The pool's price right now, before fees."
                  value={marketRate ? `1 ${tokenIn} ${APPROX} ${fmt(marketRate, tokenIn === 'ETH' ? 2 : 8)} ${tokenOut}` : '...'}
                  action={
                    <IconAction label="Refresh the market price" onClick={() => loadPrice()}>
                      <RefreshIcon size={15} />
                    </IconAction>
                  }
                />
                <DetailRow
                  label="Min received"
                  info="The order cannot fill for less than this."
                  value={limitOut ? `${fmt(limitOut, 6)} ${tokenOut}` : '...'}
                  sub={ethValueOf(tokenOut, limitOut)}
                  last
                />
              </>
            )}
          </section>

          <div className="!mt-[10px] flex items-center gap-[14px] rounded-[6px] border border-[#5a4a1c] bg-[#14110a] px-[16px] py-[8px]">
            <ShieldCheckIcon size={18} className="shrink-0 text-sun" />
            <div className="min-w-0">
              <p className="m-0 font-sans text-[9.2px] font-semibold text-white">
                {mode === 'limit' ? 'Fills when the pool reaches your price' : 'Price quote updates in real time'}
              </p>
              <p className="m-0 mt-[2px] font-sans text-[7.8px] text-[#b5b5b5]">
                {mode === 'limit'
                  ? 'Checked every few seconds. Open for 7 days. Cancel any time.'
                  : 'The final amount may change slightly due to market movement.'}
              </p>
            </div>
          </div>
        </>
      ) : (
        <LiquidityPanel
          price={price}
          lpMode={lpMode}
          setLpMode={(m) => {
            setLpMode(m);
            if (m === 'remove') loadLpPosition();
          }}
          lpEth={lpEth}
          lpFlz={lpFlz}
          setLpEth={setLpEth}
          setLpFlz={setLpFlz}
          lpPercent={lpPercent}
          setLpPercent={setLpPercent}
          lpPosition={lpPosition}
        />
      )}

      <div className="!mt-[12px]">
        <label htmlFor="swap-password" className="mb-[6px] block font-mono text-[9.4px] uppercase tracking-[0.12em] text-[#e6e6e6]">
          Account password
        </label>
        <div className="flex h-[39px] items-center gap-[12px] rounded-[5px] border border-[#2a2b30] bg-[#0d0d0e] pl-[16px] pr-[12px] focus-within:border-sun/60">
          <LockIcon size={15} className="shrink-0 text-[#d6d6d6]" />
          <input
            id="swap-password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            placeholder="Enter your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="min-w-0 flex-1 bg-transparent font-sans text-[11px] text-white outline-none placeholder:text-[#7a7a7f]"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            className="hit-44 shrink-0 font-sans text-[9px] font-medium uppercase tracking-[0.06em] text-[#e6e6e6] hover:text-white"
          >
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>

      {error ? <div className="alert alert-warn text-sm">{error}</div> : null}
      {result?.explorerUrl ? (
        <div className="alert alert-ok space-y-1 text-sm">
          <p>Confirmed on-chain.</p>
          <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="break-all">
            {result.explorerUrl}
          </a>
        </div>
      ) : result?.note ? (
        <div className="alert alert-ok text-sm">{result.note}</div>
      ) : null}

      {mode === 'swap' ? (
        <CtaButton disabled={busy || quoting || !quote || !password} onClick={runSwap}>
          {swapCta}
        </CtaButton>
      ) : mode === 'limit' ? (
        <CtaButton disabled={busy || !(Number(amountIn) > 0) || !(Number(limitPrice) > 0) || !password} onClick={placeOrder}>
          {busy ? 'Placing...' : 'Place limit order'}
        </CtaButton>
      ) : lpMode === 'add' ? (
        <CtaButton
          disabled={busy || !password || !(Number(lpEth) > 0) || !(Number(lpFlz) > 0)}
          onClick={() =>
            runLiquidity({ action: 'add', amountEth: lpEth, amountToken: lpFlz, token: 'FLZ' }, 'Liquidity failed')
          }
        >
          {busy ? 'Adding...' : 'Supply liquidity'}
        </CtaButton>
      ) : (
        <CtaButton
          disabled={busy || !password || !lpPosition || !(Number(lpPosition.lpBalanceFormatted) > 0)}
          onClick={() => runLiquidity({ action: 'remove', percent: lpPercent }, 'Remove liquidity failed')}
        >
          {busy ? 'Removing...' : `Remove ${lpPercent}% liquidity`}
        </CtaButton>
      )}

      {mode === 'limit' && orders.length ? (
        <section className="rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[14px] py-[12px]">
          <h3 className="m-0 font-sans text-[11px] font-semibold text-white">Your limit orders</h3>
          <ul className="m-0 mt-[9px] grid list-none gap-[5px] p-0">
            {orders.map((o) => (
              <li key={o.id} className="flex items-center gap-[10px] rounded-[5px] border border-[#1f1f22] bg-[#0f0f10] px-[11px] py-[8px]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-sans text-[10px] text-white">
                    {fmt(o.amountIn)} {o.tokenIn} for at least {fmt(o.minOut)} {o.tokenOut}
                  </span>
                  <span className="block truncate font-sans text-[8.4px] text-[#a9a9a9]">
                    {orderStatusLine(o)}
                  </span>
                </span>
                {o.status === 'open' ? (
                  <button
                    type="button"
                    onClick={() => cancelOrder(o.id)}
                    className="hit-y-44 shrink-0 rounded-[4px] border border-[#2a2b30] bg-[#0f0f10] px-[10px] py-[5px] font-sans text-[9px] text-[#e6e6e6] hover:text-white"
                  >
                    Cancel
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppPage>
  );
}

function orderStatusLine(o: LimitOrder): string {
  if (o.status === 'open') {
    const left = new Date(o.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `Open until ${left}`;
  }
  if (o.status === 'filling') return 'Filling now';
  if (o.status === 'filled') return 'Filled';
  if (o.status === 'cancelled') return 'Cancelled';
  if (o.status === 'expired') return 'Expired';
  return o.error ? `Failed: ${o.error}` : 'Failed';
}

function ModeTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-[13px] rounded-[5px] font-sans text-[10px] font-medium ${
        active ? 'border-[1.5px] border-sun bg-sun-wash text-sun' : 'text-[#d6d6d6] hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function TokenLogo({ token, size = 36 }: { token: Token; size?: number }) {
  if (token === 'ETH') {
    return (
      <span className="flex shrink-0 items-center justify-center rounded-full border border-[#2e2e2e] bg-[#161616] text-[#e6e6e6]" style={{ width: size, height: size }}>
        <EthDiamondIcon size={Math.round(size * 0.58)} />
      </span>
    );
  }
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full border-[1.5px] border-sun bg-[#0a0a0a] font-sans font-bold text-sun"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.52) }}
    >
      {token.slice(0, 1)}
    </span>
  );
}

function TokenPanel({
  label,
  token,
  balance,
  onMax,
  options,
  onToken,
  amount,
  sub,
}: {
  label: string;
  token: Token;
  balance: string;
  onMax?: () => void;
  options: Token[];
  onToken: (t: Token) => void;
  amount: ReactNode;
  sub?: ReactNode;
}) {
  const bal = Number(balance);
  const balLabel = !Number.isFinite(bal) || bal === 0 ? '0' : bal >= 1 ? fmt(bal, 4) : bal.toPrecision(4);
  return (
    <div className="rounded-[5px] border border-[#23242a] bg-[#0d0d0e] px-[3.5px] pb-[3.5px]">
      <div className="flex h-[29px] items-center justify-between pl-[7px] pr-[3.5px]">
        <span className="font-sans text-[11.5px] font-medium text-white">{label}</span>
        <span className="flex items-center gap-[8px]">
          <span className="font-sans text-[10px] text-[#a9a9a9]">Balance: {balLabel}</span>
          {onMax ? (
            <button
              type="button"
              onClick={onMax}
              className="hit-44 flex h-[21px] items-center rounded-[4px] border border-[#8a7428] bg-[#1c180c] px-[7px] font-sans text-[8.6px] font-bold text-sun"
            >
              MAX
            </button>
          ) : null}
        </span>
      </div>
      <div className="flex h-[59px] rounded-[5px] border border-[#2a2b30] bg-[#0b0b0c]">
        <label className="relative flex w-[138px] shrink-0 cursor-pointer items-center gap-[11px] border-r border-[#2a2b30] pl-[11px] pr-[10px]">
          <TokenLogo token={token} />
          <span className="min-w-0 flex-1">
            <span className="block font-sans text-[11.5px] font-semibold text-white">{token}</span>
            <span className="block truncate font-sans text-[9.2px] text-[#a9a9a9]">{tokenName(token)}</span>
          </span>
          <ChevronDownIcon size={11} className="shrink-0 text-[#d9d9d9]" />
          <select
            aria-label={`${label} token`}
            value={token}
            onChange={(e) => onToken(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          >
            {options.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <div className="flex min-w-0 flex-1 flex-col justify-center pl-[10px] pr-[11px]">
          {amount}
          {sub ? <span className="mt-[2px] block truncate text-right font-sans text-[9.5px] text-[#a9a9a9]">{sub}</span> : null}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  info,
  value,
  sub,
  action,
  last,
}: {
  label: string;
  info: string;
  value: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`flex min-h-[35px] items-center justify-between gap-[10px] py-[8px] ${last ? '' : 'border-b border-[#1f1f22]'}`}>
      <span className="flex items-center gap-[9px] font-sans text-[10.5px] text-[#cfcfcf]">
        {label}
        <span title={info} aria-label={info} role="img" className="text-[#a9a9a9]">
          <InfoIcon size={12} />
        </span>
      </span>
      <span className="flex items-center gap-[12px]">
        <span className="grid justify-items-end">
          <span className="font-sans text-[10.5px] text-white">{value}</span>
          {sub ? <span className="font-sans text-[9.5px] text-[#b5b5b5]">{sub}</span> : null}
        </span>
        {action}
      </span>
    </div>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className="hit-44 flex text-sun hover:brightness-110">
      {children}
    </button>
  );
}

/**
 * A number edited in place in a detail row. Enter or leaving the field saves;
 * Escape cancels. With onLive, every valid keystroke applies at once, so the
 * figures that depend on it never lag behind what is typed.
 */
function InlineNumber({
  initial,
  prefix,
  suffix,
  label,
  onCommit,
  onCancel,
  onLive,
}: {
  initial: string;
  prefix?: string;
  suffix?: string;
  label: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  onLive?: (v: string) => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <span className="flex items-center gap-[5px]">
      {prefix ? <span>{prefix}</span> : null}
      <input
        autoFocus
        aria-label={label}
        inputMode="decimal"
        value={v}
        onChange={(e) => {
          const next = e.target.value.replace(/[^0-9.]/g, '');
          setV(next);
          if (onLive && Number(next) > 0) onLive(next);
        }}
        onBlur={() => onCommit(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(v);
          if (e.key === 'Escape') onCancel();
        }}
        className="w-[78px] rounded-[3px] border border-sun/60 bg-[#0b0b0c] px-[5px] py-[2px] text-right font-sans text-[10.5px] text-white outline-none"
      />
      {suffix ? <span>{suffix}</span> : null}
    </span>
  );
}

function CtaButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="btn-sun !mt-[11px] h-[37px] w-full gap-[14px] rounded-[5px] font-sans text-[12.5px] font-medium tracking-[0.02em]"
    >
      {children}
      <ArrowRightIcon size={15} strokeWidth={2} />
    </button>
  );
}

function LiquidityPanel({
  price,
  lpMode,
  setLpMode,
  lpEth,
  lpFlz,
  setLpEth,
  setLpFlz,
  lpPercent,
  setLpPercent,
  lpPosition,
}: {
  price: PriceInfo | null;
  lpMode: 'add' | 'remove';
  setLpMode: (m: 'add' | 'remove') => void;
  lpEth: string;
  lpFlz: string;
  setLpEth: (v: string) => void;
  setLpFlz: (v: string) => void;
  lpPercent: number;
  setLpPercent: (n: number) => void;
  lpPosition: { lpBalanceFormatted: string; ethShare: string; flzShare: string; poolShareBps: number } | null;
}) {
  const flzPerEth = Number(price?.tokenPerEth || 0);
  const lp = Number(lpPosition?.lpBalanceFormatted || 0);
  const frac = Math.min(100, Math.max(1, lpPercent)) / 100;
  const field =
    'h-[36px] w-full rounded-[4px] border border-[#2a2b30] bg-[#0b0b0c] px-[11px] text-right font-sans text-[14px] font-semibold text-white outline-none focus:border-sun/60';

  return (
    <section
      className="grid gap-[11px] rounded-[6px] border border-[#3a3017] px-[11.5px] pb-[13px] pt-[12px]"
      style={{ background: 'linear-gradient(180deg, #13110b 0%, #0e0d0b 100%)' }}
    >
      <div>
        <h2 className="m-0 font-sans text-[13.5px] font-semibold text-white">Liquidity</h2>
        <p className="m-0 mt-[4px] font-sans text-[10px] text-[#9d9d9d]">
          {price
            ? `Pool ${fmt(price.reserveWeth, 4)} ETH / ${fmt(price.reserveToken, 0)} FLZ`
            : `GIWA Sepolia ${DOT} ETH / FLZ`}
        </p>
      </div>
      <div className="flex h-[32px] rounded-[5px] border border-chrome-line bg-[#0e0f11]" role="tablist" aria-label="Liquidity action">
        <ModeTab active={lpMode === 'add'} onClick={() => setLpMode('add')} icon={<PlusIcon size={11} />} label="Add" />
        <ModeTab active={lpMode === 'remove'} onClick={() => setLpMode('remove')} icon={<RefreshIcon size={11} />} label="Remove" />
      </div>

      {lpMode === 'add' ? (
        <>
          <label className="grid gap-[5px] font-sans text-[10px] text-[#cfcfcf]">
            ETH
            <input
              className={field}
              inputMode="decimal"
              value={lpEth}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '');
                setLpEth(v);
                if (flzPerEth > 0 && Number(v) > 0) setLpFlz(String(Number((Number(v) * flzPerEth).toFixed(4))));
              }}
            />
          </label>
          <label className="grid gap-[5px] font-sans text-[10px] text-[#cfcfcf]">
            FLZ
            <input
              className={field}
              inputMode="decimal"
              value={lpFlz}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '');
                setLpFlz(v);
                if (flzPerEth > 0 && Number(v) > 0) setLpEth(String(Number((Number(v) / flzPerEth).toFixed(6))));
              }}
            />
          </label>
          <p className="m-0 font-sans text-[9px] text-[#a9a9a9]">
            LP tokens go to your Flizy wallet. No protocol fee on add.
          </p>
        </>
      ) : (
        <>
          <div className="grid gap-[4px] rounded-[5px] border border-[#23242a] bg-[#0d0d0e] px-[11px] py-[9px] font-sans text-[10px] text-[#a9a9a9]">
            <span className="flex justify-between">
              Your LP <span className="text-white">{lpPosition ? fmt(lpPosition.lpBalanceFormatted, 6) : '...'} FLZ-LP</span>
            </span>
            <span className="flex justify-between">
              Pooled ETH <span className="text-white">{lpPosition ? fmt(lpPosition.ethShare, 6) : '...'}</span>
            </span>
            <span className="flex justify-between">
              Pooled FLZ <span className="text-white">{lpPosition ? fmt(lpPosition.flzShare, 4) : '...'}</span>
            </span>
          </div>
          <div className="grid grid-cols-4 gap-[5px]">
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setLpPercent(p)}
                className={`h-[30px] rounded-[4px] border font-sans text-[10px] ${
                  lpPercent === p ? 'border-sun bg-sun-wash text-sun' : 'border-[#2a2b30] bg-[#0f0f10] text-[#d6d6d6]'
                }`}
              >
                {p === 100 ? 'Max' : `${p}%`}
              </button>
            ))}
          </div>
          <p className="m-0 font-sans text-[9px] text-[#a9a9a9]">
            {lp > 0 && lpPosition
              ? `You receive about ${fmt(Number(lpPosition.ethShare) * frac, 6)} ETH and ${fmt(Number(lpPosition.flzShare) * frac, 4)} FLZ.`
              : 'No LP position yet. Supply liquidity first.'}
          </p>
        </>
      )}
    </section>
  );
}
