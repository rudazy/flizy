'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PrivyProvider, useConnectWallet, useWallets, type PrivyClientConfig } from '@privy-io/react-auth';
import type { EIP1193Provider } from 'viem';
import { custodyDoorAppId } from '../lib/custodyDoor';
import { GIWA } from '../lib/walletChain';

/**
 * A wallet the visitor owns, connected to the site. Not a Flizy account and not
 * a Flizy wallet: Flizy never holds its key, stores its address, or signs for it.
 *
 * Two ways to connect, one interface:
 *   - Privy's connect-wallet modal when NEXT_PUBLIC_PRIVY_APP_ID is set:
 *     MetaMask, Coinbase, Rabby and WalletConnect, so phones work too. Privy is
 *     used for the connection only; nobody logs in to Privy here.
 *   - Otherwise the wallet built into the browser (EIP-1193), as a fallback, so
 *     Connect always works.
 *
 * Whether the visitor chose to disconnect is remembered in this browser only.
 */

type ExternalWallet = {
  /** The connected address, or null. */
  address: `0x${string}` | null;
  /** True once the connector has finished checking for a wallet already connected. */
  ready: boolean;
  /** Which connector is in use. */
  via: 'privy' | 'browser';
  /** Open the connect flow. Resolves to the address, or null when the visitor backs out. */
  connect: () => Promise<`0x${string}` | null>;
  /** Forget the wallet on this site. */
  disconnect: () => void;
  /** The provider to sign with, or null when nothing is connected. */
  provider: () => Promise<EIP1193Provider | null>;
};

const WalletContext = createContext<ExternalWallet | null>(null);

/** The connected outside wallet. Null outside an ExternalWalletProvider. */
export function useExternalWallet(): ExternalWallet | null {
  return useContext(WalletContext);
}

const OFF_KEY = 'flizy.wallet.disconnected';

function rememberOff(off: boolean) {
  try {
    if (off) window.localStorage.setItem(OFF_KEY, '1');
    else window.localStorage.removeItem(OFF_KEY);
  } catch {
    // Storage can be blocked; the only cost is a wallet that reconnects itself.
  }
}

function wasTurnedOff(): boolean {
  try {
    return window.localStorage.getItem(OFF_KEY) === '1';
  } catch {
    return false;
  }
}

function asAddress(value: unknown): `0x${string}` | null {
  const s = String(value || '');
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? (s as `0x${string}`) : null;
}

const privyConfig: PrivyClientConfig = {
  // Connection only: the site's own login is email and password.
  loginMethods: ['wallet'],
  embeddedWallets: { ethereum: { createOnLogin: 'off' } },
  supportedChains: [
    {
      id: GIWA.id,
      name: GIWA.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [GIWA.rpcUrl] } },
      blockExplorers: { default: { name: 'GIWA explorer', url: GIWA.explorerUrl } },
      testnet: true,
    },
  ],
  appearance: {
    theme: 'dark',
    accentColor: '#f7d043',
    walletList: ['detected_wallets', 'metamask', 'coinbase_wallet', 'rainbow', 'wallet_connect'],
  },
  legal: {
    termsAndConditionsUrl: 'https://flizy.app/terms',
    privacyPolicyUrl: 'https://flizy.app/privacy',
  },
};

export function ExternalWalletProvider({ children }: { children: ReactNode }) {
  const appId = custodyDoorAppId();
  if (!appId) return <BrowserWallet>{children}</BrowserWallet>;
  return (
    <PrivyProvider appId={appId} config={privyConfig}>
      <PrivyWallet>{children}</PrivyWallet>
    </PrivyProvider>
  );
}

function PrivyWallet({ children }: { children: ReactNode }) {
  const { wallets, ready } = useWallets();
  const [off, setOff] = useState(false);
  const pending = useRef<((address: `0x${string}` | null) => void) | null>(null);
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      rememberOff(false);
      setOff(false);
      pending.current?.(asAddress(wallet.address));
      pending.current = null;
    },
    onError: () => {
      pending.current?.(null);
      pending.current = null;
    },
  });

  useEffect(() => setOff(wasTurnedOff()), []);

  // Outside wallets only: an embedded Privy wallet is never treated as the visitor's own.
  const external = off ? undefined : wallets.find((w) => w.walletClientType !== 'privy');
  const address = asAddress(external?.address);

  const connect = useCallback(
    () =>
      new Promise<`0x${string}` | null>((resolve) => {
        pending.current = resolve;
        connectWallet();
      }),
    [connectWallet]
  );

  const disconnect = useCallback(() => {
    rememberOff(true);
    setOff(true);
    // Not every wallet allows a programmatic disconnect; forgetting it here is what counts.
    try {
      external?.disconnect();
    } catch {
      // Nothing to do: the site has already stopped using it.
    }
  }, [external]);

  const provider = useCallback(async () => (external ? ((await external.getEthereumProvider()) as EIP1193Provider) : null), [external]);

  const value = useMemo<ExternalWallet>(
    () => ({ address, ready, via: 'privy', connect, disconnect, provider }),
    [address, ready, connect, disconnect, provider]
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

function injected(): EIP1193Provider | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null;
}

function BrowserWallet({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const eth = injected();
    if (!eth) {
      setReady(true);
      return;
    }
    // A wallet already connected to this site comes back without a prompt,
    // unless the visitor chose to disconnect.
    if (!wasTurnedOff()) {
      eth
        .request({ method: 'eth_accounts' })
        .then((accounts) => setAddress(asAddress((accounts as string[])[0])))
        .catch(() => undefined)
        .finally(() => setReady(true));
    } else {
      setReady(true);
    }
    const onAccounts = (accounts: unknown) => {
      if (wasTurnedOff()) return;
      setAddress(asAddress((accounts as string[])[0]));
    };
    eth.on?.('accountsChanged', onAccounts);
    return () => eth.removeListener?.('accountsChanged', onAccounts);
  }, []);

  const connect = useCallback(async () => {
    const eth = injected();
    if (!eth) return null;
    try {
      const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
      const next = asAddress(accounts[0]);
      rememberOff(false);
      setAddress(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const disconnect = useCallback(() => {
    rememberOff(true);
    setAddress(null);
  }, []);

  const provider = useCallback(async () => (address ? injected() : null), [address]);

  const value = useMemo<ExternalWallet>(
    () => ({ address, ready, via: 'browser', connect, disconnect, provider }),
    [address, ready, connect, disconnect, provider]
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
