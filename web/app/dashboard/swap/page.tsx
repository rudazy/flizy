'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'next/navigation';
import { AppTopBar } from '../../../components/AppTopBar';
import { AppPage } from '../../../components/AppSection';
import { formatAmount } from '../../../lib/amountDisplay';
import { pairFromQuery, SWAP_ASSETS, type SwapToken } from '../../../lib/swapPair';
import { LISTED_TOKENS, listedBySymbol, symbolLabel } from '../../../lib/listedTokens';
import { tokenLogo } from '../../../lib/tokenLogos';
import { announceTx } from '../../../lib/txSignal';
import { AmmoraSwapPanel } from '../../../components/AmmoraSwapPanel';
import { ammoraUiEnabled } from '../../../components/AmmoraTokens';
import { pinReady } from '../../../components/PinField';
import { txPin } from '../../../lib/txPin';
import { TradeWalletSwitch, useTradeWallet } from '../../../components/WalletModeBits';
import { walletBalances, walletSwap, type WalletSwapQuote } from '../../../lib/walletTrade';
import { FLZ_TOKEN, WETH_TOKEN, walletErrorText } from '../../../lib/walletChain';
import {
  ArrowRightIcon,
  ChartLineIcon,
  ChevronDownIcon,
  CloseIcon,
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

/** True when this amount can be sent from the balance. ETH keeps a gas buffer. */
function covers(amount: string, balance: string, reserveGas: boolean): boolean {
  const amt = Number(amount);
  const bal = Number(balance);
  if (!(amt > 0) || !(bal > 0)) return false;
  const cap = reserveGas ? Math.max(0, bal - 0.00008) : bal;
  return amt <= cap + 1e-6;
}

/**
 * /dashboard/swap. With NEXT_PUBLIC_AMMORA_ENABLED on, ?venue=ammora opens the
 * Ammora venue (components/AmmoraSwapPanel.tsx); everything else is Flizy's
 * own swap, unchanged.
 */
export default function SwapRoute() {
  const search = useSearchParams();
  if (ammoraUiEnabled() && search.get('venue') === 'ammora') {
    return (
      <AppPage>
        <AppTopBar title="Swap" />
        <AmmoraSwapPanel initialToken={search.get('token')} />
      </AppPage>
    );
  }
  return <SwapPage />;
}

function SwapPage() {
  const [mode, setMode] = useState<Mode>('swap');
  // An outside wallet (wallet mode, or an account that chose its connected
  // wallet) swaps by signing itself. Limit orders and liquidity run from a
  // Flizy wallet, so they are not offered then.
  const tradeWallet = useTradeWallet();
  const walletAddress = tradeWallet?.address ?? null;
  useEffect(() => {
    if (walletAddress) setMode('swap');
  }, [walletAddress]);
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
  const [balancesReady, setBalancesReady] = useState(false);
  const [slippagePct, setSlippagePct] = useState('1.00');
  const [editingSlippage, setEditingSlippage] = useState(false);
  const [limitPrice, setLimitPrice] = useState('');
  const [editingLimit, setEditingLimit] = useState(false);
  const [orders, setOrders] = useState<LimitOrder[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const [result, setResult] = useState<{ explorerUrl?: string; note?: string } | null>(null);
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);

  const [lpMode, setLpMode] = useState<'add' | 'manage'>('add');
  const [lpEth, setLpEth] = useState('0.05');
  const [lpToken, setLpToken] = useState('');
  const [lpPercent, setLpPercent] = useState(100);
  const [lpPosition, setLpPosition] = useState<{
    lpBalanceFormatted: string;
    ethShare: string;
    symbol: string;
    tokenShare: string;
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

  // Only a limit order can take the PIN: it fills later without asking. A swap
  // or a liquidity change keeps the value in the wallet and takes none on
  // testnet, and with the transaction PIN off (web/lib/txPin.ts) neither does it.
  const pinNeeded = txPin.required && mode === 'limit';

  const loadBalances = useCallback(async () => {
    if (walletAddress) {
      try {
        const read = await walletBalances(walletAddress, [
          { address: FLZ_TOKEN, decimals: 18 },
          ...LISTED_TOKENS.map((t) => ({ address: t.address, decimals: t.decimals })),
        ]);
        const next: Balances = { ETH: read.eth, FLZ: read.tokens[FLZ_TOKEN.toLowerCase()] ?? '0' };
        for (const listed of LISTED_TOKENS) next[listed.symbol] = read.tokens[listed.address.toLowerCase()] ?? '0';
        setBalances(next);
        setBalancesReady(true);
      } catch {
        /* balances stay as they were */
      }
      return;
    }
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
      setBalancesReady(true);
    } catch {
      /* balances stay as they were */
    }
  }, [walletAddress]);

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
    if (walletAddress) return;
    try {
      const res = await fetch('/api/swap/limit');
      const data = await res.json();
      if (res.ok) setOrders(data.orders || []);
    } catch {
      /* the list waits for the next refresh */
    }
  }, [walletAddress]);

  const loadLpPosition = useCallback(async () => {
    try {
      const res = await fetch(`/api/swap/liquidity?token=${encodeURIComponent(asset)}`);
      const data = await res.json();
      if (!res.ok) {
        setLpPosition(null);
        return;
      }
      setLpPosition({
        lpBalanceFormatted: data.lpBalanceFormatted || '0',
        ethShare: data.ethShare || '0',
        symbol: String(data.symbol || ''),
        tokenShare: data.tokenShare || '0',
        poolShareBps: data.poolShareBps || 0,
      });
    } catch {
      setLpPosition(null);
    }
  }, [asset]);

  // A position read for another pool is not this pool's position.
  const position = lpPosition && lpPosition.symbol === asset ? lpPosition : null;

  // When the pool changes, the token amount restarts from the ETH amount at that
  // pool's price, once the price has arrived.
  const lpFilledFor = useRef('');
  useEffect(() => {
    if (mode !== 'liquidity' || lpFilledFor.current === '' || lpFilledFor.current === asset) return;
    setLpToken('');
  }, [mode, asset]);
  useEffect(() => {
    if (mode !== 'liquidity' || !price || lpFilledFor.current === asset) return;
    lpFilledFor.current = asset;
    const per = Number(price.tokenPerEth);
    setLpToken(per > 0 && Number(lpEth) > 0 ? String(Number((Number(lpEth) * per).toFixed(4))) : '');
  }, [mode, price, asset, lpEth]);

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

  /** Limit orders are for the FLZ pool only, so that mode trades FLZ. */
  function changeMode(next: Mode) {
    if (next === 'limit' && asset !== 'FLZ') {
      if (tokenIn === 'ETH') setTokenOut('FLZ');
      else setTokenIn('FLZ');
      setQuote(null);
      setLimitPrice('');
    }
    setMode(next);
  }

  /** The pool the Liquidity panel works on: the token opposite ETH. */
  function chooseAsset(next: Token) {
    if (next === asset) return;
    if (tokenIn === 'ETH') setTokenOut(next);
    else setTokenIn(next);
    setQuote(null);
    setLimitPrice('');
    setResult(null);
    setError('');
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
    if (tradeWallet) {
      try {
        const route = quote as unknown as Partial<WalletSwapQuote> | null;
        if (!route?.feeRouter || !Array.isArray(route.path) || !route.amountInUnits || !route.amountOutMinUnits) {
          throw new Error('Quote again, then swap.');
        }
        const provider = await tradeWallet.provider();
        if (!provider) throw new Error('Connect your wallet again.');
        const done = await walletSwap(provider, tradeWallet.address, route as WalletSwapQuote, WETH_TOKEN);
        setResult({ explorerUrl: done.explorerUrl });
        loadPrice();
        loadQuote();
        loadBalances();
      } catch (err) {
        setError(walletErrorText(err, 'Swap failed'));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const res = await fetch('/api/swap/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side,
          amount: amountIn,
          tokenIn,
          tokenOut,
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
        body: JSON.stringify({ action: 'place', side, amount: amountIn, price: limitPrice, pin }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not place the order.');
        return;
      }
      setResult({ note: 'Limit order placed. It fills when the pool reaches your price.' });
      setPin('');
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

  async function runLiquidity(body: Record<string, unknown>, failed: string): Promise<boolean> {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/swap/liquidity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || failed);
        return false;
      }
      setResult({ explorerUrl: data.explorerUrl });
      loadPrice();
      loadLpPosition();
      loadBalances();
      announceTx();
      return true;
    } catch {
      setError(failed);
      return false;
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
          {tradeWallet ? null : (
            <ModeTab active={mode === 'limit'} onClick={() => changeMode('limit')} icon={<ChartLineIcon size={15} />} label="Limit" />
          )}
        </div>
        {tradeWallet ? null : (
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
        )}
      </div>
      <TradeWalletSwitch className="mt-3" />

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
          asset={asset}
          assets={[...SWAP_ASSETS]}
          onAsset={chooseAsset}
          price={price}
          balances={balances}
          balancesReady={balancesReady}
          lpMode={lpMode}
          setLpMode={setLpMode}
          busy={busy}
          error={error}
          clearNotice={() => {
            setError('');
            setResult(null);
          }}
          onRemove={() => runLiquidity({ action: 'remove', percent: lpPercent, token: asset }, 'Remove liquidity failed')}
          lpEth={lpEth}
          lpToken={lpToken}
          setLpEth={setLpEth}
          setLpToken={setLpToken}
          lpPercent={lpPercent}
          setLpPercent={setLpPercent}
          lpPosition={position}
        />
      )}

      <div className="!mt-[12px]" hidden={!pinNeeded}>
        <label htmlFor="swap-pin" className="mb-[6px] block font-mono text-[9.4px] uppercase tracking-[0.12em] text-[#e6e6e6]">
          Your PIN
        </label>
        <div className="flex h-[39px] items-center gap-[12px] rounded-[5px] border border-[#2a2b30] bg-[#0d0d0e] pl-[16px] pr-[12px] focus-within:border-sun/60">
          <LockIcon size={15} className="shrink-0 text-[#d6d6d6]" />
          <input
            id="swap-pin"
            type={showPin ? 'text' : 'password'}
            inputMode="numeric"
            autoComplete="off"
            maxLength={12}
            placeholder="4 to 12 digits"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
            className="min-w-0 flex-1 bg-transparent font-sans text-[11px] text-white outline-none placeholder:text-[#7a7a7f]"
          />
          <button
            type="button"
            onClick={() => setShowPin((v) => !v)}
            aria-pressed={showPin}
            aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
            className="hit-44 shrink-0 font-sans text-[9px] font-medium uppercase tracking-[0.06em] text-[#e6e6e6] hover:text-white"
          >
            {showPin ? 'Hide' : 'Show'}
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
        <CtaButton disabled={busy || quoting || !quote} onClick={runSwap}>
          {swapCta}
        </CtaButton>
      ) : mode === 'limit' ? (
        <CtaButton disabled={busy || !(Number(amountIn) > 0) || !(Number(limitPrice) > 0) || (pinNeeded && !pinReady(pin))} onClick={placeOrder}>
          {busy ? 'Placing...' : 'Place limit order'}
        </CtaButton>
      ) : lpMode === 'add' ? (
        <CtaButton
          tall
          disabled={
            busy ||
            !covers(lpEth, balanceFor('ETH'), true) ||
            !covers(lpToken, balanceFor(asset), false)
          }
          onClick={() =>
            runLiquidity({ action: 'add', amountEth: lpEth, amountToken: lpToken, token: asset }, 'Liquidity failed')
          }
        >
          {busy ? 'Adding...' : 'Supply liquidity'}
        </CtaButton>
      ) : null}

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
  const src = tokenLogo(token);
  if (src) {
    return <img src={src} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
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
            <span className="block font-sans text-[11.5px] font-semibold text-white">{symbolLabel(token)}</span>
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
                {symbolLabel(t)}
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
    <div className={`flex min-h-[35px] min-w-0 items-center justify-between gap-[10px] py-[8px] ${last ? '' : 'border-b border-[#1f1f22]'}`}>
      <span className="flex shrink-0 items-center gap-[9px] font-sans text-[10.5px] text-[#cfcfcf]">
        {label}
        <span title={info} aria-label={info} role="img" className="text-[#a9a9a9]">
          <InfoIcon size={12} />
        </span>
      </span>
      <span className="flex min-w-0 items-center justify-end gap-[12px]">
        <span className="grid min-w-0 justify-items-end text-right">
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

function CtaButton({
  disabled,
  onClick,
  children,
  tall,
}: {
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
  tall?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`btn-sun !mt-[11px] w-full gap-[14px] rounded-[5px] font-sans font-medium tracking-[0.02em] ${
        tall ? 'h-[48px] text-[15px]' : 'h-[37px] text-[12.5px]'
      }`}
    >
      {children}
      <ArrowRightIcon size={15} strokeWidth={2} />
    </button>
  );
}

/** Gold share slider. The badge follows the thumb. */
function ShareSlider({
  pct,
  min,
  disabled,
  onChange,
  label,
  marks,
}: {
  pct: number;
  min: number;
  disabled: boolean;
  onChange: (n: number) => void;
  label: string;
  marks?: number[];
}) {
  return (
    <div className="relative mx-[8px] mt-[28px]">
      <span
        className="pointer-events-none absolute -top-[26px] rounded-[4px] bg-sun px-[6px] py-[1px] font-sans text-[10px] font-bold text-sun-ink"
        style={{ left: `${pct}%`, transform: `translateX(-${pct}%)` }}
        aria-hidden
      >
        {pct}%
      </span>
      <input
        type="range"
        min={min}
        max={100}
        step={1}
        value={pct}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="h-[8px] w-full cursor-pointer appearance-none rounded-full accent-sun disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: `linear-gradient(90deg, #f7d047 ${pct}%, #262626 ${pct}%)` }}
      />
      {marks ? (
        <span className="relative mt-[10px] block h-[32px]">
          {marks.map((mark) => {
            const place = mark <= 0 ? 'translateX(0)' : mark >= 100 ? 'translateX(-100%)' : 'translateX(-50%)';
            const style = { left: `${mark}%`, transform: place, position: 'absolute' as const };
            const tone = pct === mark ? 'font-semibold text-sun' : 'text-[#8a8a8a]';
            if (mark < min) {
              return (
                <span key={mark} className={`top-0 whitespace-nowrap font-sans text-[10px] ${tone}`} style={style}>
                  {mark}%
                </span>
              );
            }
            return (
              <button
                key={mark}
                type="button"
                disabled={disabled}
                onClick={() => onChange(mark)}
                className={`hit-y-44 top-0 whitespace-nowrap px-[2px] font-sans text-[10px] disabled:opacity-40 ${tone}`}
                style={style}
              >
                {mark}%
              </button>
            );
          })}
        </span>
      ) : (
        <span className="mt-[6px] flex justify-between font-sans text-[9px] text-[#8a8a8a]">
          <span>{min}%</span>
          <span>100%</span>
        </span>
      )}
    </div>
  );
}

function balanceLabel(balance: string): string {
  const bal = Number(balance);
  if (!Number.isFinite(bal) || bal === 0) return '0';
  return bal >= 1 ? fmt(bal, 4) : bal.toPrecision(4);
}

/** Pool share is stored in basis points. Under a hundredth of a percent still reads as present. */
function shareLabel(bps: number): string {
  if (!(bps > 0)) return '0%';
  const pct = bps / 100;
  return pct < 0.01 ? '< 0.01%' : `${pct.toFixed(2)}%`;
}

type PoolHolding = {
  symbol: Token;
  lpBalanceFormatted: string;
  ethShare: string;
  tokenShare: string;
  poolShareBps: number;
  hasPosition: boolean;
  ok: boolean;
};

function PairMark({ token, back = 'ETH' }: { token: Token; back?: Token }) {
  return (
    <span className="relative h-[36px] w-[56px] shrink-0">
      <span className="absolute left-0 top-0">
        <TokenLogo token={back} size={34} />
      </span>
      <span className="absolute left-[22px] top-0 rounded-full ring-2 ring-[#0d0d0e]">
        <TokenLogo token={token} size={34} />
      </span>
    </span>
  );
}

/** Token menu on an amount. The native select is the control; the label is the face. */
function TokenSelect({
  label,
  token,
  options,
  onChange,
}: {
  label: string;
  token: Token;
  options: Token[];
  onChange: (t: Token) => void;
}) {
  return (
    <label className="relative flex h-[44px] w-[46%] min-w-[108px] max-w-[148px] shrink-0 cursor-pointer items-center gap-[8px] rounded-[8px] border border-[#3a3017] bg-[#14120c] pl-[8px] pr-[8px]">
      <TokenLogo token={token} size={26} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[13px] font-semibold leading-[16px] text-white">{symbolLabel(token)}</span>
        <span className="block truncate font-sans text-[9px] text-[#9d9d9d]">{tokenName(token)}</span>
      </span>
      <ChevronDownIcon size={12} className="shrink-0 text-[#d6c48a]" />
      <select
        aria-label={label}
        value={token}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer text-base opacity-0"
      >
        {options.map((t) => (
          <option key={t} value={t}>
            {symbolLabel(t)}, {tokenName(t)}
          </option>
        ))}
      </select>
    </label>
  );
}

function LiquidityPanel({
  asset,
  assets,
  onAsset,
  price,
  balances,
  balancesReady,
  lpMode,
  setLpMode,
  busy,
  error,
  clearNotice,
  onRemove,
  lpEth,
  lpToken,
  setLpEth,
  setLpToken,
  lpPercent,
  setLpPercent,
  lpPosition,
}: {
  asset: Token;
  assets: Token[];
  onAsset: (t: Token) => void;
  price: PriceInfo | null;
  balances: Balances;
  balancesReady: boolean;
  lpMode: 'add' | 'manage';
  setLpMode: (m: 'add' | 'manage') => void;
  busy: boolean;
  error: string;
  clearNotice: () => void;
  onRemove: () => Promise<boolean>;
  lpEth: string;
  lpToken: string;
  setLpEth: (v: string) => void;
  setLpToken: (v: string) => void;
  lpPercent: number;
  setLpPercent: (n: number) => void;
  lpPosition: { lpBalanceFormatted: string; ethShare: string; tokenShare: string; poolShareBps: number } | null;
}) {
  const [amountToken, setAmountToken] = useState<Token>('ETH');
  const [pairedToken, setPairedToken] = useState<Token>(asset);
  const [holdings, setHoldings] = useState<PoolHolding[] | null>(null);
  const [menuFor, setMenuFor] = useState<Token | null>(null);
  const [removing, setRemoving] = useState<Token | null>(null);
  const [holdingReload, setHoldingReload] = useState(0);
  const menuRef = useRef<HTMLLIElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const removeLock = useRef(false);
  const poolKey = assets.join(',');
  const pairTokens: Token[] = ['ETH', ...assets];
  // A real pool is ETH against one listed token. Two other tokens have no pair.
  const poolSymbol: Token | null =
    amountToken !== pairedToken && (amountToken === 'ETH' || pairedToken === 'ETH')
      ? amountToken === 'ETH'
        ? pairedToken
        : amountToken
      : null;
  const aligned = poolSymbol != null && poolSymbol === asset;
  const tokenPerEth = aligned ? Number(price?.tokenPerEth || 0) : 0;
  const frac = Math.min(100, Math.max(1, lpPercent)) / 100;
  const addingEth = amountToken === 'ETH';
  const activeToken: Token = amountToken;
  const otherToken: Token = pairedToken;
  const activeBalance = balances[amountToken] ?? '0';
  const activeAmount = addingEth ? lpEth : lpToken;
  const pairedAmount = addingEth ? lpToken : lpEth;
  const bal = Number(activeBalance);
  const amt = Number(activeAmount);
  const pct = aligned && bal > 0 && amt > 0 ? Math.max(0, Math.min(100, Math.round((amt / bal) * 100))) : 0;

  const reserveEth = aligned ? Number(price?.reserveWeth || 0) : 0;
  const addEth = Number(lpEth);
  let addShare = '...';
  if (reserveEth > 0 && addEth > 0) {
    const share = (addEth / (reserveEth + addEth)) * 100;
    addShare = share < 0.01 ? '< 0.01%' : `${share.toFixed(2)}%`;
  }

  function writeEth(v: string) {
    setLpEth(v);
    if (tokenPerEth > 0 && Number(v) > 0) setLpToken(String(Number((Number(v) * tokenPerEth).toFixed(4))));
  }

  function writeToken(v: string) {
    setLpToken(v);
    if (tokenPerEth > 0 && Number(v) > 0) setLpEth(String(Number((Number(v) / tokenPerEth).toFixed(6))));
  }

  /** One side changes. The same token on both sides swaps them. An ETH pair selects that pool. */
  function pickSide(which: 'amount' | 'paired', next: Token) {
    const amount = which === 'amount' ? next : amountToken;
    const paired = which === 'paired' ? next : pairedToken;
    if (amount === paired) {
      setAmountToken(pairedToken);
      setPairedToken(amountToken);
      return;
    }
    if (which === 'amount') setAmountToken(next);
    else setPairedToken(next);
    const pool = amount === 'ETH' ? paired : paired === 'ETH' ? amount : null;
    if (pool && pool !== asset) onAsset(pool);
  }

  function flipPair() {
    setAmountToken(pairedToken);
    setPairedToken(amountToken);
  }

  /** Share of the balance on top. 100% of ETH keeps a gas buffer. */
  function setByPercent(next: number) {
    if (!aligned || !(bal > 0)) return;
    if (next <= 0) {
      setLpEth('');
      setLpToken('');
      return;
    }
    let n = (bal * next) / 100;
    if (addingEth && next >= 100) n = Math.max(0, bal - 0.00008);
    const text = plain(n);
    if (addingEth) writeEth(text);
    else writeToken(text);
  }

  function takeMax() {
    setByPercent(100);
  }

  function openAdd(symbol: Token) {
    clearNotice();
    onAsset(symbol);
    setAmountToken('ETH');
    setPairedToken(symbol);
    setLpMode('add');
    setMenuFor(null);
  }

  function openRemove(symbol: Token) {
    clearNotice();
    onAsset(symbol);
    setLpPercent(50);
    setRemoving(symbol);
    setMenuFor(null);
  }

  async function confirmRemove() {
    if (removeLock.current || busy) return;
    removeLock.current = true;
    try {
      const ok = await onRemove();
      if (!ok) return;
      setRemoving(null);
      setMenuFor(null);
      setHoldingReload((n) => n + 1);
    } finally {
      removeLock.current = false;
    }
  }

  // The slider is a share of the balance of the token on top. An amount above
  // that balance is cut back to it. A token this wallet does not hold is left
  // alone here: the field hides it, and switching back restores the other side.
  useEffect(() => {
    if (!balancesReady || lpMode !== 'add' || !aligned) return;
    const balance = Number(balances[amountToken] ?? '0');
    const current = Number(addingEth ? lpEth : lpToken);
    if (!(balance > 0)) return;
    if (!(current > balance + 1e-6)) return;
    let n = balance;
    if (addingEth) n = Math.max(0, balance - 0.00008);
    const text = plain(n);
    if (!(Number(text) > 0)) {
      setLpEth('');
      setLpToken('');
      return;
    }
    if (addingEth) {
      setLpEth(text);
      if (tokenPerEth > 0) setLpToken(String(Number((n * tokenPerEth).toFixed(4))));
      return;
    }
    setLpToken(text);
    if (tokenPerEth > 0) setLpEth(String(Number((n / tokenPerEth).toFixed(6))));
  }, [balancesReady, lpMode, aligned, addingEth, amountToken, balances, lpEth, lpToken, tokenPerEth, setLpEth, setLpToken]);

  useEffect(() => {
    if (poolSymbol) return;
    if (lpEth === '' && lpToken === '') return;
    setLpEth('');
    setLpToken('');
  }, [poolSymbol, lpEth, lpToken, setLpEth, setLpToken]);

  useEffect(() => {
    if (lpMode !== 'manage') return;
    let cancel = false;
    const symbols = poolKey.split(',').filter(Boolean) as Token[];
    Promise.all(
      symbols.map(async (token): Promise<PoolHolding> => {
        try {
          const res = await fetch(`/api/swap/liquidity?token=${encodeURIComponent(token)}`);
          const data = await res.json();
          if (!res.ok) {
            return { symbol: token, lpBalanceFormatted: '0', ethShare: '0', tokenShare: '0', poolShareBps: 0, hasPosition: false, ok: false };
          }
          const lpBalanceFormatted = String(data.lpBalanceFormatted || '0');
          return {
            symbol: token,
            lpBalanceFormatted,
            ethShare: String(data.ethShare || '0'),
            tokenShare: String(data.tokenShare || '0'),
            poolShareBps: Number(data.poolShareBps) || 0,
            hasPosition: Boolean(data.hasPosition) || Number(lpBalanceFormatted) > 0,
            ok: true,
          };
        } catch {
          return { symbol: token, lpBalanceFormatted: '0', ethShare: '0', tokenShare: '0', poolShareBps: 0, hasPosition: false, ok: false };
        }
      })
    ).then((list) => {
      if (cancel) return;
      list.sort((a, b) => Number(b.hasPosition) - Number(a.hasPosition));
      setHoldings(list);
    });
    return () => {
      cancel = true;
    };
  }, [lpMode, poolKey, holdingReload]);

  useEffect(() => {
    if (!menuFor) return;
    function onPointer(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuFor(null);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuFor(null);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  useEffect(() => {
    if (!removing) return;
    dialogRef.current?.focus();
  }, [removing]);

  useEffect(() => {
    if (!removing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) setRemoving(null);
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [removing, busy]);

  const poolLine = !poolSymbol
    ? `No ${amountToken}/${pairedToken} pool. Each Flizy pool pairs a token with ETH.`
    : aligned && price
      ? `Pool ${fmt(price.reserveWeth, 4)} ETH / ${fmt(price.reserveToken, 0)} ${poolSymbol}`
      : `GIWA Sepolia ${DOT} ${amountToken} / ${pairedToken}`;
  const heldCount = holdings ? holdings.filter((row) => row.ok && row.hasPosition).length : null;
  const manageLine =
    heldCount == null
      ? 'Add to a pool, or remove part of one.'
      : heldCount === 0
        ? 'None of these pools hold your liquidity yet.'
        : heldCount === 1
          ? 'You have liquidity in 1 pool.'
          : `You have liquidity in ${heldCount} pools.`;
  const removingRow = removing ? (holdings?.find((row) => row.symbol === removing) ?? null) : null;
  const live = removing && removing === asset && lpPosition ? lpPosition : null;
  const lpText = live?.lpBalanceFormatted ?? removingRow?.lpBalanceFormatted ?? '0';
  const ethText = live?.ethShare ?? removingRow?.ethShare ?? '0';
  const tokenText = live?.tokenShare ?? removingRow?.tokenShare ?? '0';
  const shareBps = live?.poolShareBps ?? removingRow?.poolShareBps ?? 0;
  const canRemove = Boolean(
    removingRow?.ok && Number(live ? live.lpBalanceFormatted : removingRow?.lpBalanceFormatted) > 0
  );
  const outEth = Number(ethText) * frac;
  const outToken = Number(tokenText) * frac;
  const ratio = removing && removing === asset && price ? Number(price.tokenPerEth) : 0;
  const dialogPool =
    removing && price && removing === asset
      ? `Pool ${fmt(price.reserveWeth, 4)} ETH / ${fmt(price.reserveToken, 0)} ${removing}`
      : removing
        ? `GIWA Sepolia ${DOT} ETH / ${removing}`
        : '';

  const slideReady = aligned && balancesReady && bal > 0;

  return (
    <>
    <section
      className="grid min-w-0 grid-cols-1 gap-[14px] rounded-[8px] border border-[#3a3017] px-[12px] pb-[14px] pt-[14px] shadow-[0_0_28px_rgba(247,208,71,0.07)]"
      style={{ background: 'linear-gradient(180deg, #16130c 0%, #0c0b09 100%)' }}
    >
      <div className="flex min-w-0 items-start justify-between gap-[10px]">
        <div className="min-w-0">
          <h2 className="m-0 font-sans text-[20px] font-semibold leading-[24px] text-white">
            {lpMode === 'add' ? 'Add liquidity' : 'Your pools'}
          </h2>
          <p className="m-0 mt-[3px] font-sans text-[11px] text-[#9d9d9d]">
            {lpMode === 'add' ? 'Provide liquidity and earn pool fees.' : manageLine}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setLpMode(lpMode === 'add' ? 'manage' : 'add')}
          className="hit-y-44 flex h-[32px] shrink-0 items-center gap-[6px] rounded-[8px] border border-[#3a3017] bg-[#14120c] px-[10px] font-sans text-[10px] text-sun hover:bg-[#1c1810]"
        >
          {lpMode === 'add' ? 'Manage pools' : 'Add liquidity'}
          <ArrowRightIcon size={12} />
        </button>
      </div>

      {lpMode === 'add' ? (
      <div className="flex min-w-0 items-center gap-[12px] rounded-[8px] border border-[#2a2416] bg-[#0d0d0e] px-[12px] py-[10px]">
        <PairMark back={amountToken} token={pairedToken} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-[8px]">
            <span className="font-sans text-[14px] font-semibold text-white">
              {amountToken} / {pairedToken}
            </span>
            {poolSymbol ? (
              <span
                title="The pool's swap fee. Adding liquidity does not pay it."
                className="rounded-[4px] border border-[#3a3017] bg-[#16140e] px-[7px] py-[2px] font-sans text-[9px] text-[#d6c48a]"
              >
                0.30% pool fee
              </span>
            ) : null}
          </span>
          <span className="mt-[2px] block font-sans text-[10px] leading-[14px] text-[#9d9d9d]">{poolLine}</span>
        </span>
      </div>
      ) : holdings === null ? (
        <p className="m-0 rounded-[8px] border border-[#2a2416] bg-[#0d0d0e] px-[12px] py-[16px] font-sans text-[12px] text-[#9d9d9d]">
          Reading your pools...
        </p>
      ) : holdings.length === 0 ? (
        <p className="m-0 rounded-[8px] border border-[#2a2416] bg-[#0d0d0e] px-[12px] py-[16px] font-sans text-[12px] text-[#9d9d9d]">
          No pools to show.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-[8px] p-0">
          {holdings.map((row) => {
            const open = menuFor === row.symbol;
            return (
              <li
                key={row.symbol}
                ref={open ? menuRef : undefined}
                className={`rounded-[8px] border bg-[#0d0d0e] px-[12px] py-[12px] ${open ? 'border-[#5a4a1c]' : 'border-[#2a2416]'}`}
              >
                <div className="flex items-center gap-[12px]">
                  <PairMark token={row.symbol} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-[8px]">
                      <span className="font-sans text-[14px] font-semibold text-white">ETH / {row.symbol}</span>
                      <span
                        title="The pool's swap fee. Adding or removing liquidity does not pay it."
                        className="rounded-[4px] border border-[#3a3017] bg-[#16140e] px-[7px] py-[2px] font-sans text-[9px] text-[#d6c48a]"
                      >
                        0.30% fee
                      </span>
                    </span>
                    <span className="mt-[2px] block truncate font-sans text-[10px] text-[#9d9d9d]">
                      {!row.ok
                        ? 'Could not read this pool'
                        : row.hasPosition
                          ? `${shareLabel(row.poolShareBps)} of this pool`
                          : 'No liquidity in this pool'}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-haspopup="menu"
                    aria-controls={open ? `pool-menu-${row.symbol}` : undefined}
                    aria-label={`Add or remove in the ETH / ${row.symbol} pool`}
                    onClick={() => setMenuFor(open ? null : row.symbol)}
                    className="hit-y-44 flex h-[32px] shrink-0 items-center gap-[4px] rounded-[8px] border border-[#3a3017] bg-[#14120c] px-[10px] font-sans text-[10px] font-semibold text-sun"
                  >
                    Manage
                    <ChevronDownIcon size={12} className={open ? 'rotate-180' : ''} />
                  </button>
                </div>
                {row.ok && row.hasPosition ? (
                  <div className="mt-[10px] grid grid-cols-2 gap-[8px]">
                    <div className="min-w-0 rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[10px] py-[8px]">
                      <p className="m-0 font-sans text-[9px] text-[#9d9d9d]">Pooled ETH</p>
                      <p className="m-0 mt-[3px] flex items-center gap-[6px] truncate font-sans text-[13px] font-semibold text-white">
                        <TokenLogo token="ETH" size={16} />
                        {fmt(row.ethShare, 6)}
                      </p>
                    </div>
                    <div className="min-w-0 rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[10px] py-[8px]">
                      <p className="m-0 font-sans text-[9px] text-[#9d9d9d]">Pooled {row.symbol}</p>
                      <p className="m-0 mt-[3px] flex items-center gap-[6px] truncate font-sans text-[13px] font-semibold text-white">
                        <TokenLogo token={row.symbol} size={16} />
                        {fmt(row.tokenShare, 4)}
                      </p>
                    </div>
                  </div>
                ) : null}
                {open ? (
                  <div id={`pool-menu-${row.symbol}`} role="menu" aria-label={`ETH / ${row.symbol}`} className="mt-[10px] grid grid-cols-2 gap-[8px]">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => openAdd(row.symbol)}
                      className="flex h-[44px] flex-col items-center justify-center rounded-[8px] border border-[#3a3017] bg-[#14120c] font-sans hover:bg-[#1c1810]"
                    >
                      <span className="text-[12px] font-semibold text-white">Add</span>
                      <span className="text-[9px] text-[#9d9d9d]">Put more in</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!row.ok || !row.hasPosition}
                      title={row.ok && row.hasPosition ? 'Take part of your share out' : 'No liquidity in this pool'}
                      onClick={() => openRemove(row.symbol)}
                      className="flex h-[44px] flex-col items-center justify-center rounded-[8px] border border-sun bg-sun-wash font-sans disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <span className="text-[12px] font-semibold text-sun">Remove</span>
                      <span className="text-[9px] text-[#d6c48a]">
                        {row.ok && row.hasPosition ? 'Take a share out' : 'Nothing to remove'}
                      </span>
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {lpMode === 'add' ? (
        <div className="grid min-w-0 grid-cols-1">
          <div className="min-w-0 rounded-[8px] border border-[#2a2416] bg-[#0c0c0d] px-[12px] pb-[12px] pt-[11px]">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-[8px] gap-y-[6px]">
              <span className="font-sans text-[13px] font-medium text-white">Amount</span>
              <span className="ml-auto flex min-w-0 items-center gap-[8px]">
                <span className="min-w-0 truncate font-sans text-[10px] text-[#a9a9a9]">
                  Balance: {balancesReady ? balanceLabel(activeBalance) : '...'} {activeToken}
                </span>
                <button
                  type="button"
                  onClick={takeMax}
                  disabled={!slideReady}
                  className="hit-44 flex h-[24px] shrink-0 items-center rounded-[4px] border border-sun bg-[#1c180c] px-[8px] font-sans text-[10px] font-bold text-sun disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Max
                </button>
              </span>
            </div>
            <div className="mt-[12px] flex min-w-0 items-center gap-[10px]">
              <TokenSelect label="Amount token" token={amountToken} options={pairTokens} onChange={(t) => pickSide('amount', t)} />
              <input
                aria-label={`Amount of ${activeToken}`}
                className="min-w-0 flex-1 bg-transparent text-right font-sans text-[26px] font-semibold text-white outline-none placeholder:text-[#5c5c60] disabled:text-[#8a8a8a]"
                inputMode="decimal"
                value={aligned && (!balancesReady || bal > 0) ? activeAmount : ''}
                placeholder="0"
                disabled={!slideReady}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.]/g, '');
                  if (addingEth) writeEth(v);
                  else writeToken(v);
                }}
              />
            </div>
            <p className="m-0 mt-[2px] text-right font-sans text-[11px] text-[#a9a9a9]">
              {aligned && bal > 0 && Number(pairedAmount) > 0 ? `${APPROX} ${fmt(pairedAmount, addingEth ? 4 : 6)} ${otherToken}` : `${APPROX} 0 ${otherToken}`}
            </p>
            <ShareSlider
              pct={pct}
              min={0}
              disabled={!slideReady}
              onChange={setByPercent}
              label="Share of your balance"
            />
            {!poolSymbol ? (
              <p className="m-0 mt-[8px] font-sans text-[10px] text-[#d6c48a]">
                Pick ETH on one side. This pair has no pool, so the slider stays at 0.
              </p>
            ) : !aligned ? (
              <p className="m-0 mt-[8px] font-sans text-[10px] text-[#d6c48a]">Reading this pool...</p>
            ) : !balancesReady ? (
              <p className="m-0 mt-[8px] font-sans text-[10px] text-[#d6c48a]">Reading your balance...</p>
            ) : !(bal > 0) ? (
              <p className="m-0 mt-[8px] font-sans text-[10px] text-[#d6c48a]">
                This wallet holds no {activeToken}, so this slider stays at 0.
              </p>
            ) : null}
          </div>

          <div className="relative z-10 flex justify-center py-[2px]">
            <button
              type="button"
              onClick={flipPair}
              aria-label="Switch the amount and the paired token"
              className="pointer-events-auto flex h-[36px] w-[36px] items-center justify-center rounded-full border-[1.5px] border-sun bg-[#0f0d07] text-sun"
            >
              <SwapVerticalIcon size={16} />
            </button>
          </div>

          <div className="min-w-0 rounded-[8px] border border-[#2a2416] bg-[#0c0c0d] px-[12px] pb-[12px] pt-[14px]">
            <span className="font-sans text-[13px] font-medium text-white">Paired amount</span>
            <div className="mt-[12px] flex min-w-0 items-center gap-[10px]">
              <TokenSelect label="Paired token" token={pairedToken} options={pairTokens} onChange={(t) => pickSide('paired', t)} />
              <span className="min-w-0 flex-1 truncate text-right font-sans text-[26px] font-semibold text-white">
                {aligned && bal > 0 && Number(pairedAmount) > 0 ? fmt(pairedAmount, addingEth ? 4 : 6) : '0'}
              </span>
            </div>
            <p className="m-0 mt-[8px] font-sans text-[10px] text-[#a9a9a9]">LP tokens go to your Flizy wallet.</p>
            {aligned && balancesReady && bal > 0 && Number(pairedAmount) > (otherToken === 'ETH' ? Math.max(0, Number(balances.ETH ?? '0') - 0.00008) : Number(balances[otherToken] ?? '0')) + 1e-6 ? (
              <p className="m-0 mt-[4px] font-sans text-[10px] text-[#d6c48a]">
                This needs more {otherToken} than this wallet holds.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {lpMode === 'add' ? (
        <div className="min-w-0 rounded-[8px] border border-[#1f1f22] bg-[#0c0c0d] px-[14px]">
          <DetailRow
            label="Price ratio"
            info="The pool's price right now. The paired amount follows it."
            value={!poolSymbol ? 'No pool' : tokenPerEth > 0 ? `1 ETH = ${fmt(tokenPerEth, 2)} ${poolSymbol}` : '...'}
          />
          <DetailRow
            label="This add's share"
            info="Your new ETH against the pool after this add lands."
            value={addShare}
          />
          <DetailRow
            label="Slippage"
            info="The add is refused if either side comes back more than 2% under the amount you send."
            value="2%"
          />
          <DetailRow
            label="Protocol fee"
            info="No protocol fee on add. You still pay gas."
            value="0%"
            last
          />
        </div>
      ) : null}
    </section>
    {removing && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/75 p-3"
            role="presentation"
            onClick={() => {
              if (!busy) setRemoving(null);
            }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="remove-liquidity-title"
              tabIndex={-1}
              onClick={(event) => event.stopPropagation()}
              className="max-h-[calc(100dvh-24px)] w-full max-w-[420px] overflow-y-auto rounded-[12px] border border-[#3a3017] px-[14px] pb-[14px] pt-[14px] shadow-[0_0_40px_rgba(247,208,71,0.14)] outline-none"
              style={{ background: 'linear-gradient(180deg, #16130c 0%, #0c0b09 100%)' }}
            >
              <div className="flex items-start justify-between gap-[10px]">
                <div className="min-w-0">
                  <h2 id="remove-liquidity-title" className="m-0 font-sans text-[20px] font-semibold leading-[24px] text-white">
                    Remove liquidity
                  </h2>
                  <p className="m-0 mt-[3px] font-sans text-[11px] text-[#9d9d9d]">Remove your liquidity from this pool.</p>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  disabled={busy}
                  onClick={() => setRemoving(null)}
                  className="hit-44 flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[8px] border border-[#2a2b30] bg-[#141416] text-[#e6e6e6] hover:text-white disabled:opacity-40"
                >
                  <CloseIcon size={14} />
                </button>
              </div>

              <div className="mt-[14px] flex items-center gap-[12px] rounded-[8px] border border-[#2a2416] bg-[#0d0d0e] px-[12px] py-[10px]">
                <PairMark token={removing} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-[8px]">
                    <span className="font-sans text-[14px] font-semibold text-white">ETH / {removing}</span>
                    <span
                      title="The pool's swap fee. Removing liquidity does not pay it."
                      className="rounded-[4px] border border-[#3a3017] bg-[#16140e] px-[7px] py-[2px] font-sans text-[9px] text-[#d6c48a]"
                    >
                      0.30% fee
                    </span>
                  </span>
                  <span className="mt-[2px] block truncate font-sans text-[10px] text-[#9d9d9d]">{dialogPool}</span>
                </span>
              </div>

              <div className="mt-[10px] rounded-[8px] border border-[#2a2416] bg-[#0c0c0d] px-[12px] py-[12px]">
                <div className="flex items-start justify-between gap-[8px]">
                  <span>
                    <span className="block font-sans text-[13px] font-medium text-white">Your liquidity</span>
                    <span className="mt-[2px] block font-sans text-[10px] text-[#9d9d9d]">Your share of this pool</span>
                  </span>
                  <span className="font-sans text-[12px] font-semibold text-[#d6c48a]">{shareLabel(shareBps)}</span>
                </div>
                <div className="mt-[10px] grid grid-cols-3 gap-[8px] border-t border-[#1f1f22] pt-[10px]">
                  <div className="min-w-0">
                    <p className="m-0 font-sans text-[9px] leading-[12px] text-[#9d9d9d]">Your LP tokens</p>
                    <p className="m-0 mt-[4px] truncate font-sans text-[13px] font-semibold text-white">{fmt(lpText, 4)}</p>
                    <p className="m-0 truncate font-sans text-[9px] text-[#8a8a8a]">{removing}-LP</p>
                  </div>
                  <div className="min-w-0">
                    <p className="m-0 font-sans text-[9px] leading-[12px] text-[#9d9d9d]">Pooled ETH</p>
                    <p className="m-0 mt-[4px] flex items-center gap-[5px] truncate font-sans text-[13px] font-semibold text-white">
                      <TokenLogo token="ETH" size={14} />
                      {fmt(ethText, 6)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="m-0 font-sans text-[9px] leading-[12px] text-[#9d9d9d]">Pooled {removing}</p>
                    <p className="m-0 mt-[4px] flex items-center gap-[5px] truncate font-sans text-[13px] font-semibold text-white">
                      <TokenLogo token={removing} size={14} />
                      {fmt(tokenText, 4)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-[10px] rounded-[8px] border border-[#2a2416] bg-[#0c0c0d] px-[8px] pb-[12px] pt-[12px]">
                <div className="flex items-center justify-between gap-[8px] px-[6px]">
                  <span className="font-sans text-[13px] font-medium text-white">Amount to remove</span>
                  <span className="font-sans text-[11px] text-[#cfcfcf]">Receive (estimated)</span>
                </div>
                <ShareSlider
                  pct={lpPercent}
                  min={1}
                  disabled={busy || !canRemove}
                  onChange={setLpPercent}
                  label="Share of your position to remove"
                  marks={[0, 25, 50, 75, 100]}
                />
                <div className="mx-[4px] mt-[8px] grid grid-cols-2 overflow-hidden rounded-[8px] border border-[#2a2416]">
                  <div className="flex min-w-0 items-center gap-[8px] px-[10px] py-[10px]">
                    <TokenLogo token="ETH" size={28} />
                    <span className="min-w-0">
                      <span className="block font-sans text-[10px] text-[#cfcfcf]">ETH</span>
                      <span className="block truncate font-sans text-[15px] font-semibold text-white">{canRemove ? fmt(outEth, 6) : '0'}</span>
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-[8px] border-l border-[#2a2416] px-[10px] py-[10px]">
                    <TokenLogo token={removing} size={28} />
                    <span className="min-w-0">
                      <span className="block font-sans text-[10px] text-[#cfcfcf]">{removing}</span>
                      <span className="block truncate font-sans text-[15px] font-semibold text-white">{canRemove ? fmt(outToken, 4) : '0'}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-[10px] rounded-[8px] border border-[#1f1f22] bg-[#0c0c0d] px-[14px]">
                <DetailRow
                  label="Price ratio"
                  info="The pool's price right now. The amounts follow your share of it."
                  value={ratio > 0 ? `1 ETH = ${fmt(ratio, 2)} ${removing}` : '...'}
                />
                <DetailRow
                  label="Your share of pool"
                  info="Your LP tokens against the whole pool."
                  value={shareLabel(shareBps)}
                />
                <DetailRow
                  label="Slippage"
                  info="The remove is refused if either side comes back more than 2% under your share."
                  value="2%"
                />
                <DetailRow
                  label="Protocol fee"
                  info="No protocol fee on remove. You still pay gas."
                  value="0%"
                  last
                />
              </div>

              <div className="sticky bottom-0 -mx-[14px] mt-[12px] border-t border-[#2a2416] bg-[#0c0b09] px-[14px] pb-[4px] pt-[10px]">
                {error ? (
                  <p className="m-0 mb-[8px] rounded-[6px] border border-[#5a3a1c] bg-[#1a120c] px-[12px] py-[8px] font-sans text-[11px] text-[#f0d2a0]" role="alert">
                    {error}
                  </p>
                ) : null}
                {!canRemove ? <p className="m-0 mb-[4px] font-sans text-[11px] text-[#9d9d9d]">No liquidity in this pool.</p> : null}
                <CtaButton tall disabled={busy || !canRemove} onClick={() => { void confirmRemove(); }}>
                  {busy ? 'Removing...' : `Remove liquidity (${lpPercent}%)`}
                </CtaButton>
              </div>
            </div>
          </div>,
          document.body
        )
      : null}
    </>
  );
}
