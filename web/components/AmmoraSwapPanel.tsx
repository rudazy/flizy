'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { PinField, pinReady } from './PinField';
import { announceTx } from '../lib/txSignal';

/**
 * The swap screen on the Ammora venue: buy or sell one Ammora token against
 * native ETH. Shown by /dashboard/swap?venue=ammora only when
 * NEXT_PUBLIC_AMMORA_ENABLED is "true".
 *
 * The plan shows what the server will hold the swap to: the minimum received,
 * Ammora's fee with its rate, price impact (unavailable from Ammora, said so
 * rather than guessed), the token's contract and the Ammora source label.
 * Every Ammora swap takes the PIN (never in Flizy's verified set). The swap
 * goes through /api/swap/execute and Flizy's own executor.
 */

type TokenView = { address: string; symbol: string; name: string; tradable: boolean; label: string };
type Quote = {
  amountOut: string;
  amountOutMin: string;
  fee: { amountEth: string; rate: string; label: string };
  priceImpact: string;
  token: TokenView;
};

const SLIPPAGE_BPS = 100;
const QUOTE_DEBOUNCE_MS = 400;
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

export function AmmoraSwapPanel({ initialToken }: { initialToken: string | null }) {
  const [tokens, setTokens] = useState<TokenView[] | null>(null);
  const [token, setToken] = useState(initialToken || '');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.001');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteFor, setQuoteFor] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [explorerUrl, setExplorerUrl] = useState('');
  const seq = useRef(0);

  useEffect(() => {
    fetch('/api/ammora/tokens', { cache: 'no-store' })
      .then((res) => res.json().catch(() => ({})))
      .then((body) => {
        const list: TokenView[] = Array.isArray(body.tokens) ? body.tokens.filter((t: TokenView) => t.tradable) : [];
        setTokens(list);
        if (!initialToken && list[0]) setToken(list[0].address);
      })
      .catch(() => setTokens([]));
  }, [initialToken]);

  const inputs = `${side}|${token}|${amount}`;
  const loadQuote = useCallback(async () => {
    if (!token || !(Number(amount) > 0)) {
      setQuote(null);
      return;
    }
    const mine = ++seq.current;
    setError('');
    const q = new URLSearchParams({ venue: 'ammora', side, token, amount, slippageBps: String(SLIPPAGE_BPS) });
    try {
      const res = await fetch(`/api/swap/quote?${q}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok) {
        setQuote(null);
        setError(body.error || 'Could not get an Ammora quote.');
        return;
      }
      setQuote(body);
      setQuoteFor(`${side}|${token}|${amount}`);
    } catch {
      if (mine === seq.current) setError('Could not get an Ammora quote.');
    }
  }, [side, token, amount]);

  useEffect(() => {
    const t = setTimeout(loadQuote, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [loadQuote]);

  // A quote counts only for the inputs it was made for.
  const shown = quote && quoteFor === inputs ? quote : null;
  const selected = (tokens || []).find((t) => t.address.toLowerCase() === token.toLowerCase());
  const symbol = shown?.token.symbol || selected?.symbol || 'token';

  async function swap() {
    if (!shown || !pinReady(pin) || busy) return;
    setBusy(true);
    setError('');
    setExplorerUrl('');
    try {
      const res = await fetch('/api/swap/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venue: 'ammora',
          side,
          token,
          amount,
          pin,
          slippageBps: SLIPPAGE_BPS,
          // The minimum on screen. The server refuses a fill below it.
          minOut: shown.amountOutMin,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error || 'Swap failed');
        return;
      }
      setPin('');
      setExplorerUrl(body.explorerUrl || '');
      announceTx();
      loadQuote();
    } catch {
      setError('Swap failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-[12px]" aria-labelledby="ammora-swap">
      <div>
        <h2 id="ammora-swap" className="m-0 font-sans text-[15px] font-bold text-white">
          Swap on Ammora
        </h2>
        <p className="m-0 mt-[4px] font-sans text-[10.4px] text-[#a9a9a9]">
          Ammora is a separate venue on GIWA. Flizy has not reviewed these tokens. <Link href="/dashboard/swap">Back to Flizy swap</Link>
        </p>
      </div>

      <label className="grid gap-[6px] font-sans text-[10px] text-[#e6e6e6]">
        Token
        <select
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-[36px] rounded-[5px] border border-[#2a2b30] bg-[#0d0d0e] px-[10px] text-[11px] text-white"
        >
          {token && !selected ? <option value={token}>{short(token)}</option> : null}
          {(tokens || []).map((t) => (
            <option key={t.address} value={t.address}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-[8px]" role="group" aria-label="Buy or sell">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className={`h-[34px] flex-1 rounded-[5px] border font-sans text-[11px] ${
              side === s ? 'border-sun text-sun' : 'border-[#2a2b30] text-[#d6d6d6]'
            }`}
          >
            {s === 'buy' ? `Buy ${symbol} with ETH` : `Sell ${symbol} for ETH`}
          </button>
        ))}
      </div>

      <label className="grid gap-[6px] font-sans text-[10px] text-[#e6e6e6]">
        {side === 'buy' ? 'You pay (ETH)' : `You pay (${symbol})`}
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          className="h-[36px] rounded-[5px] border border-[#2a2b30] bg-[#0d0d0e] px-[10px] font-sans text-[12px] text-white outline-none focus:border-sun/60"
        />
      </label>

      {shown ? (
        <dl className="m-0 grid gap-[6px] rounded-[6px] border border-[#1f1f22] bg-[#0c0c0d] px-[14px] py-[12px] font-sans text-[10.4px]">
          <Row label="You receive (about)" value={`${shown.amountOut} ${side === 'buy' ? symbol : 'ETH'}`} />
          <Row label="Minimum received" value={`${shown.amountOutMin} ${side === 'buy' ? symbol : 'ETH'}`} />
          <Row label={shown.fee.label} value={`${shown.fee.amountEth} ETH${shown.fee.rate ? ` (${shown.fee.rate})` : ''}`} />
          <Row label="Price impact" value={shown.priceImpact === 'unavailable' ? 'Unavailable from Ammora' : shown.priceImpact} />
          <Row label="Token" value={shown.token.label} />
          <Row label="Contract" value={shown.token.address} mono />
          <Row label="Flizy fee" value="None on Ammora swaps" />
        </dl>
      ) : null}

      <PinField id="ammora-pin" value={pin} onChange={setPin} />
      {error ? <p className="alert alert-warn m-0 text-sm">{error}</p> : null}
      {explorerUrl ? (
        <p className="alert alert-ok m-0 text-sm">
          Confirmed on-chain.{' '}
          <a href={explorerUrl} target="_blank" rel="noreferrer" className="break-all">
            {explorerUrl}
          </a>
        </p>
      ) : null}
      <button
        type="button"
        disabled={busy || !shown || !pinReady(pin)}
        onClick={() => void swap()}
        className="h-[40px] rounded-[5px] bg-sun font-sans text-[12px] font-semibold text-black disabled:opacity-50"
      >
        {busy ? 'Swapping...' : side === 'buy' ? `Buy ${symbol} on Ammora` : `Sell ${symbol} on Ammora`}
      </button>
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-[12px]">
      <dt className="text-[#a9a9a9]">{label}</dt>
      <dd className={`m-0 break-all text-right text-white ${mono ? 'font-mono text-[9.6px]' : ''}`}>{value}</dd>
    </div>
  );
}
