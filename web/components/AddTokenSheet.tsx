'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, CopyIcon, TokensIcon } from './ExploreIcons';

type Found = { address: string; symbol: string; decimals: number };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const FIELD =
  'flex h-[50px] items-center gap-[12px] rounded-[10px] border border-[#2e2f34] bg-[#0d0d0e] pl-[8px] pr-[10px] focus-within:border-sun/70';
const FIELD_ICON = 'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[7px] bg-[#1a1a1c] text-[#e6e6e6]';
const INPUT = 'h-full min-w-0 flex-1 bg-transparent font-sans text-[14px] text-white outline-none placeholder:text-[#7c7c7c]';

/**
 * Add a token to the wallet, as a dialog over Balances. Only GIWA Sepolia
 * tokens can be added. Pasting a contract reads its symbol and decimals from
 * the chain and fills them in; the saved row always takes both from the chain,
 * and a value typed here has to agree with it.
 */
export function AddTokenSheet({
  open,
  onClose,
  onAdded,
  onManage,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (message: string) => void;
  onManage: (() => void) | null;
}) {
  const [contract, setContract] = useState('');
  const [symbol, setSymbol] = useState('');
  const [decimals, setDecimals] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [looking, setLooking] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const contractRef = useRef<HTMLInputElement | null>(null);
  // The latest onClose, so a parent that re-renders does not reset the form.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Fresh form each time it opens, with the cursor in the contract field.
  useEffect(() => {
    if (!open) return;
    setContract('');
    setSymbol('');
    setDecimals('');
    setFound(null);
    setError('');
    setBusy(false);
    const t = window.setTimeout(() => contractRef.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Look the contract up once it is a whole address.
  useEffect(() => {
    const address = contract.trim();
    setFound(null);
    if (!ADDRESS.test(address)) {
      setLooking(false);
      return;
    }
    setLooking(true);
    setError('');
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/wallet/tokens?address=${encodeURIComponent(address)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || !body.token) {
          setError(typeof body.error === 'string' ? body.error : 'Could not read that contract.');
          return;
        }
        const token = body.token as Found;
        setFound(token);
        setSymbol(token.symbol);
        setDecimals(String(token.decimals));
      } catch {
        if (!cancelled) setError('Could not read that contract.');
      } finally {
        if (!cancelled) setLooking(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [contract]);

  if (!open) return null;

  async function paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setContract(text.trim().slice(0, 200));
    } catch {
      setError('Paste is blocked here. Long-press the field to paste.');
    }
  }

  async function submit() {
    const address = contract.trim();
    if (busy) return;
    if (!ADDRESS.test(address)) {
      setError('Enter a contract address: 0x and 40 characters.');
      return;
    }
    const typedDecimals = decimals.trim();
    if (typedDecimals && !/^\d{1,3}$/.test(typedDecimals)) {
      setError('Decimals is a whole number, like 18.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/wallet/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
          ...(typedDecimals ? { decimals: Number(typedDecimals) } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === 'string' ? body.error : 'Could not add that token.');
        return;
      }
      const name = body.token?.symbol || 'Token';
      const balance = body.token?.balance;
      const holds = balance != null && Number(balance) > 0;
      onAdded(holds ? `${name} added.` : `${name} added. It shows here once this wallet holds some.`);
    } catch {
      setError('Could not add that token.');
    } finally {
      setBusy(false);
    }
  }

  // On document.body: an animated ancestor would otherwise pin the overlay to itself.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-token-title"
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[90dvh] w-full max-w-[400px] overflow-y-auto rounded-[18px] border border-[#2e2a20] px-[18px] pb-[18px] pt-[20px] shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
        style={{ background: 'radial-gradient(70% 50% at 70% 0%, rgba(70, 52, 14, 0.45) 0%, rgba(16, 15, 13, 0) 70%), #101011' }}
      >
        <div className="flex items-start gap-[14px]">
          <span className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[10px] border border-[#3a3017] bg-[#1c180c] text-sun">
            <TokensIcon size={22} />
          </span>
          <div className="min-w-0 flex-1 pt-[1px]">
            <h2 id="add-token-title" className="m-0 font-sans text-[20px] font-bold leading-[24px] text-white">
              Add token
            </h2>
            <p className="m-0 mt-[3px] font-sans text-[13px] text-[#bdbdbd]">Add a GIWA token to your wallet</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="hit-44 flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full border border-[#3a3b40] bg-[#1a1a1c] text-white"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <form
          className="mt-[18px] grid gap-[6px]"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Label htmlFor="add-token-network">Network</Label>
          <div className="relative flex h-[50px] items-center gap-[10px] rounded-[10px] border border-[#6b5a25] bg-[#1a160b] px-[10px]">
            <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-sun font-sans text-[15px] font-bold text-sun-ink">
              G
            </span>
            <span className="font-sans text-[14px] font-semibold text-white">GIWA Sepolia</span>
            <span className="rounded-[5px] bg-[#2a2924] px-[7px] py-[2px] font-sans text-[11px] text-[#ececec]">Testnet</span>
            {/* One network today. The select is real so the field says what it is, and offers nothing else. */}
            <select
              id="add-token-network"
              aria-label="Network"
              className="absolute inset-0 cursor-pointer opacity-0"
              value="giwa-sepolia"
              onChange={() => undefined}
            >
              <option value="giwa-sepolia">GIWA Sepolia (Testnet)</option>
            </select>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="pointer-events-none ml-auto text-[#e6e6e6]">
              <path d="M6.5 9.5L12 15l5.5-5.5" />
            </svg>
          </div>
          <p className="m-0 font-sans text-[11.5px] text-[#a9a9a9]">Only GIWA tokens can be added.</p>

          <Label htmlFor="add-token-contract" className="mt-[10px]">
            Contract address
          </Label>
          <div className={FIELD}>
            <span className={FIELD_ICON}>
              <LinkMark />
            </span>
            <input
              id="add-token-contract"
              ref={contractRef}
              className={`${INPUT} font-mono text-[13px]`}
              value={contract}
              onChange={(e) => {
                setContract(e.target.value.slice(0, 200));
                setError('');
              }}
              placeholder="Enter contract address"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button type="button" onClick={() => void paste()} aria-label="Paste contract address" className="hit-44 shrink-0 text-[#e6e6e6] hover:text-white">
              <CopyIcon size={18} />
            </button>
          </div>
          {looking ? <p className="m-0 font-sans text-[11.5px] text-[#a9a9a9]">Reading the contract...</p> : null}
          {found ? (
            <p className="m-0 font-sans text-[11.5px] text-[#2fd27a]">
              Found {found.symbol} on GIWA Sepolia, {found.decimals} decimals.
            </p>
          ) : null}

          <Label htmlFor="add-token-symbol" className="mt-[10px]">
            Symbol
          </Label>
          <div className={FIELD}>
            <span className={FIELD_ICON}>
              <BarsMark />
            </span>
            <input
              id="add-token-symbol"
              className={INPUT}
              value={symbol}
              onChange={(e) => {
                setSymbol(e.target.value.slice(0, 32));
                setError('');
              }}
              placeholder="Enter token symbol (e.g. FLZ)"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </div>

          <Label htmlFor="add-token-decimals" className="mt-[10px]">
            Decimal point
          </Label>
          <div className={FIELD}>
            <span className={`${FIELD_ICON} font-sans text-[18px] font-semibold`}>#</span>
            <input
              id="add-token-decimals"
              className={INPUT}
              value={decimals}
              onChange={(e) => {
                setDecimals(e.target.value.replace(/[^0-9]/g, '').slice(0, 3));
                setError('');
              }}
              placeholder="Enter decimals (e.g. 18)"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>

          {error ? (
            <p className="m-0 mt-[6px] rounded-[8px] border border-[#5a3f1a] bg-[#1a130a] px-[10px] py-[8px] font-sans text-[12px] text-[#e0b070]" role="alert">
              {error}
            </p>
          ) : null}

          <div className="mt-[14px] grid grid-cols-2 gap-[12px]">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-[46px] rounded-[10px] border border-[#3a3b40] bg-transparent font-sans text-[15px] font-medium text-white hover:border-[#55565c] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !contract.trim()}
              className="btn-sun h-[46px] rounded-[10px] font-sans text-[15px] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Adding...' : 'Add token'}
            </button>
          </div>
          {onManage ? (
            <button type="button" onClick={onManage} className="hit-y-44 mx-auto mt-[6px] font-sans text-[12px] text-[#a9a9a9] hover:text-white">
              Remove a token you added
            </button>
          ) : null}
        </form>
      </div>
    </div>,
    document.body
  );
}

function Label({ htmlFor, className = '', children }: { htmlFor: string; className?: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className={`font-sans text-[15px] font-semibold text-white ${className}`}>
      {children}
    </label>
  );
}

function LinkMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function BarsMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="4" y="11" width="3.2" height="9" rx="1.2" />
      <rect x="10.4" y="5" width="3.2" height="15" rx="1.2" />
      <rect x="16.8" y="9" width="3.2" height="11" rx="1.2" />
    </svg>
  );
}
