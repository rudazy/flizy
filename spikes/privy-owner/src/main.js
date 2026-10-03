/**
 * Privy owner spike page. Signs what the local step server asks for and
 * reports the result. No keys here: the server holds the throwaway keys and
 * the Privy App Secret is never used in the browser.
 */

import { createElement as h, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useSignMessage, useSignTypedData, useWallets } from '@privy-io/react-auth';
import { defineChain } from 'viem';

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  network: 'giwa-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: 'https://sepolia-explorer.giwa.io' } },
  testnet: true,
});

const STEPS = [
  ['S1', 'Privy wallet signs a message and an EIP-712 payload'],
  ['S2', 'Throwaway gator, owned by a throwaway EOA, funded with ETH and FLZ'],
  ['S3', 'Move ownership to the Privy wallet; old owner signature rejected'],
  ['S4', 'Privy wallet signs the ETH and FLZ delegations (ERC-1271 check)'],
  ['S5', 'Delegate redeems: in-bounds ETH, out-of-bounds ETH, FLZ'],
  ['S6', 'Revoke the ETH delegation (Privy-signed UserOp)'],
  ['S7', 'Owner exit: 0.01 ETH and 5 FLZ to the Privy wallet (Privy-signed UserOp)'],
  ['S8', 'Gator address and code unchanged throughout'],
  ['S9', 'Guest MetaMask wallet through Privy: self-transfer on GIWA Sepolia'],
];

async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function App() {
  const { ready, authenticated, login, logout, connectWallet } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const { signTypedData } = useSignTypedData();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [log, setLog] = useState('');

  const embedded = wallets.find((w) => w.walletClientType === 'privy');
  const guest = wallets.find((w) => w.walletClientType !== 'privy');

  const refresh = useCallback(() => api('state').then(setState).catch((e) => setLog(`state: ${e.message}`)), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  async function run(id, fn) {
    setBusy(id);
    setLog(`${id} running...`);
    try {
      const out = await fn();
      setLog(`${id} ${out.status}\n${JSON.stringify(out, null, 2)}`);
    } catch (e) {
      setLog(`${id} error: ${e.message}`);
    } finally {
      setBusy(null);
      refresh();
    }
  }

  // Full eth_signTypedData_v4 JSON, EIP712Domain included, from the server.
  const signTyped = (td) => signTypedData(td, { address: embedded.address }).then((r) => r.signature);

  const actions = {
    S1: async () => {
      const ch = await api('s1/challenge', {});
      const m = await signMessage({ message: ch.message }, { address: embedded.address });
      const t = await signTyped(ch.typedData);
      return api('s1/verify', {
        address: embedded.address,
        messageSig: m.signature,
        typedSig: t,
        walletClientType: embedded.walletClientType,
      });
    },
    S2: () => api('s2', {}),
    S3: () => api('s3', {}),
    S4: async () => {
      const p = await api('s4/payload', {});
      const ethSig = await signTyped(p.eth);
      const flzSig = await signTyped(p.flz);
      return api('s4/verify', { ethSig, flzSig });
    },
    S5: () => api('s5', {}),
    S6: async () => {
      const p = await api('s6/payload', {});
      return api('s6/submit', { signature: await signTyped(p.typedData) });
    },
    S7: async () => {
      const p = await api('s7/payload', {});
      return api('s7/submit', { signature: await signTyped(p.typedData) });
    },
    S8: () => api('s8', {}),
    S9: async () => {
      if (!guest) throw new Error('connect MetaMask first');
      await guest.switchChain(giwaSepolia.id);
      const provider = await guest.getEthereumProvider();
      const tx = await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: guest.address, to: guest.address, value: '0x0' }],
      });
      return api('s9/verify', { address: guest.address, tx, walletClientType: guest.walletClientType });
    },
  };

  const needsEmbedded = new Set(['S1', 'S4', 'S6', 'S7']);
  const steps = (state && state.steps) || {};

  return h(
    'main',
    null,
    h('h1', null, 'Privy as HybridDeleGator owner, GIWA Sepolia 91342'),
    h('p', { className: 'muted' }, 'Throwaway accounts and testnet amounts only. Run the steps in order.'),
    !ready
      ? h('p', null, 'Loading Privy...')
      : h(
          'div',
          { className: 'row' },
          authenticated
            ? h('button', { onClick: logout }, 'Log out')
            : h('button', { onClick: login }, 'Log in with email'),
          h('button', { onClick: () => connectWallet() }, 'Connect MetaMask (S9)'),
          h(
            'span',
            { className: 'muted' },
            `embedded: ${embedded ? embedded.address : 'none'} | guest: ${guest ? `${guest.address} (${guest.walletClientType})` : 'none'}`
          )
        ),
    state && state.gator ? h('p', { className: 'muted' }, `gator ${state.gator.address}`) : null,
    ...STEPS.map(([id, what]) =>
      h(
        'div',
        { className: 'row', key: id },
        h('span', { className: 'id' }, id),
        h('span', { className: 'what' }, what),
        h('span', { className: `status ${steps[id] ? steps[id].status : ''}` }, steps[id] ? steps[id].status : '-'),
        h(
          'button',
          {
            disabled: Boolean(busy) || (needsEmbedded.has(id) && !embedded) || (id === 'S9' && !guest),
            onClick: () => run(id, actions[id]),
          },
          busy === id ? 'Running' : 'Run'
        )
      )
    ),
    log ? h('pre', null, log) : null
  );
}

const appId = import.meta.env.VITE_PRIVY_APP_ID;
const root = createRoot(document.getElementById('root'));

if (!appId) {
  root.render(h('main', null, h('p', null, 'Set VITE_PRIVY_APP_ID in spikes/privy-owner/.env.spike, then restart the page.')));
} else {
  root.render(
    h(
      PrivyProvider,
      {
        appId,
        config: {
          loginMethods: ['email', 'wallet'],
          defaultChain: giwaSepolia,
          supportedChains: [giwaSepolia],
          embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
          appearance: { theme: 'dark', walletList: ['metamask'] },
        },
      },
      h(App)
    )
  );
}
