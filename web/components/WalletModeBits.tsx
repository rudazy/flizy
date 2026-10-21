'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';
import { useExternalWallet } from './ExternalWalletProvider';
import { useDashboard } from './DashboardProvider';
import { isWalletModePath, WALLET_MODE_HOME } from '../lib/walletMode';
import { shortAddress } from '../lib/walletChain';

/**
 * "Continue with a wallet": connect the visitor's own wallet and open the part
 * of the app it can use without a Flizy account (lib/walletMode.ts). Lands on
 * `next` when that is a wallet-mode page, otherwise on Explore.
 */
export function useWalletDoor(next?: string | null) {
  const wallet = useExternalWallet();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    if (!wallet || busy) return;
    setBusy(true);
    setError('');
    try {
      const address = wallet.address ?? (await wallet.connect());
      if (!address) {
        setError(
          wallet.via === 'browser'
            ? 'No wallet found in this browser. Open Flizy in your wallet app, or install a wallet extension.'
            : 'No wallet was connected.'
        );
        return;
      }
      router.push(next && isWalletModePath(next) ? next : WALLET_MODE_HOME);
    } finally {
      setBusy(false);
    }
  }

  return { go, busy, error, available: Boolean(wallet) };
}

export function ContinueWithWallet({
  next,
  className,
  children,
}: {
  next?: string | null;
  className?: string;
  children?: React.ReactNode;
}) {
  const { go, busy, error, available } = useWalletDoor(next);
  return (
    <div className="grid gap-1">
      <button type="button" onClick={() => void go()} disabled={!available || busy} className={className}>
        {children ?? (busy ? 'Connecting...' : 'Continue with a wallet')}
      </button>
      {error ? (
        <p className="m-0 text-xs text-[#e0b070]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Top of every wallet-mode page: which wallet, and what an account adds. */
export function WalletModeBar() {
  const wallet = useExternalWallet();
  const router = useRouter();
  if (!wallet?.address) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-[#2a2a2e] bg-[#0f0f10] px-3 py-2 font-sans text-[12.5px] text-[#d9d4ca]">
      <span className="text-sun">Wallet</span>
      <span className="font-mono text-white">{shortAddress(wallet.address)}</span>
      <span className="hidden text-[#8d8d8d] sm:inline">Your wallet signs every trade.</span>
      <span className="ml-auto flex items-center gap-3">
        <Link href="/signup" className="text-sun no-underline hover:opacity-80">
          Create a Flizy account
        </Link>
        <button
          type="button"
          className="text-[#8d8d8d] hover:text-white"
          onClick={() => {
            wallet.disconnect();
            router.push('/');
          }}
        >
          Disconnect
        </button>
      </span>
    </div>
  );
}

/** A page that needs a Flizy account, opened in wallet mode. */
export function NeedsAccount() {
  return (
    <div className="fade-up mx-auto max-w-md space-y-4 py-8">
      <h1 className="font-sans text-2xl tracking-wide text-paper">This needs a Flizy account</h1>
      <p className="text-sm text-muted">
        With your wallet you can explore, swap tokens and trade NFTs. Paying people by username or phone, chat on
        WhatsApp and Telegram, requests, claims and the faucet come with a Flizy account.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href={WALLET_MODE_HOME} className="btn btn-primary no-underline">
          Explore
        </Link>
        <Link href="/dashboard/swap" className="btn btn-ghost no-underline">
          Swap
        </Link>
        <Link href="/signup" className="btn btn-ghost no-underline">
          Create account
        </Link>
      </div>
    </div>
  );
}

/**
 * The visitor's own wallet, when the app is in wallet mode: no Flizy session
 * and a wallet connected. Null for a signed-in account, whose trades run from
 * the Flizy wallet as before. For what a signed-in account trades from, see
 * useTradeWallet.
 */
export function useWalletMode(): OutsideWallet | null {
  const { signedOut, data } = useDashboard();
  const wallet = useExternalWallet();
  if (!signedOut || data || !wallet?.address) return null;
  return { address: wallet.address, provider: wallet.provider };
}

type OutsideWallet = { address: `0x${string}`; provider: () => Promise<import('viem').EIP1193Provider | null> };

/**
 * Whether a signed-in account trades from its connected wallet instead of the
 * Flizy wallet. Kept in this browser only, like the connection itself, and
 * shared by every trade screen through a small store.
 */
const TRADE_FROM_KEY = 'flizy.wallet.tradeFrom';
const tradeFromListeners = new Set<() => void>();
/** The last choice, for a browser whose storage is blocked. */
let tradeFromOwnFallback = false;

function readTradeFromOwn(): boolean {
  try {
    return window.localStorage.getItem(TRADE_FROM_KEY) === 'own';
  } catch {
    return false;
  }
}

function subscribeTradeFrom(listener: () => void) {
  tradeFromListeners.add(listener);
  return () => {
    tradeFromListeners.delete(listener);
  };
}

/** Trade from the connected wallet (true) or the Flizy wallet (false). */
export function setTradeFromOwnWallet(own: boolean) {
  try {
    if (own) window.localStorage.setItem(TRADE_FROM_KEY, 'own');
    else window.localStorage.removeItem(TRADE_FROM_KEY);
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
  }
  tradeFromOwnFallback = own;
  tradeFromListeners.forEach((listener) => listener());
}


function useTradeFromOwn(): boolean {
  return useSyncExternalStore(
    subscribeTradeFrom,
    () => readTradeFromOwn() || tradeFromOwnFallback,
    () => false
  );
}

/**
 * The outside wallet that signs this screen's trades, or null when they run
 * from the Flizy wallet. That is the connected wallet in wallet mode, and for a
 * signed-in account only when it chose its connected wallet (TradeWalletSwitch).
 * Chat sends, payments and claims never use it.
 */
export function useTradeWallet(): OutsideWallet | null {
  const { signedOut, data } = useDashboard();
  const wallet = useExternalWallet();
  const own = useTradeFromOwn();
  if (!wallet?.address) return null;
  if (signedOut && !data) return { address: wallet.address, provider: wallet.provider };
  if (data && own) return { address: wallet.address, provider: wallet.provider };
  return null;
}

/**
 * For a signed-in account with a connected wallet: pick which wallet trades.
 * Nothing shows without both.
 */
export function TradeWalletSwitch({ disabled = false, className = '' }: { disabled?: boolean; className?: string }) {
  const { data } = useDashboard();
  const wallet = useExternalWallet();
  const own = useTradeFromOwn();
  if (!data || !wallet?.address) return null;
  const option = (active: boolean) =>
    `flex-1 rounded-[8px] px-3 py-2 font-sans text-[12.5px] transition-colors ${
      active ? 'bg-[#f7d047] font-semibold text-[#141414]' : 'text-[#b7b1a8] hover:text-white'
    }`;
  return (
    <div className={`grid gap-1 ${className}`}>
      <span className="font-sans text-[11px] uppercase tracking-[0.16em] text-[#8d867c]">Trade from</span>
      <div className="flex gap-1 rounded-[10px] border border-[#2a2b30] bg-[#0f0f10] p-1" role="group" aria-label="Trade from">
        <button type="button" className={option(!own)} aria-pressed={!own} disabled={disabled} onClick={() => setTradeFromOwnWallet(false)}>
          Flizy wallet
        </button>
        <button type="button" className={option(own)} aria-pressed={own} disabled={disabled} onClick={() => setTradeFromOwnWallet(true)}>
          <span className="font-mono">{shortAddress(wallet.address)}</span>
        </button>
      </div>
    </div>
  );
}
