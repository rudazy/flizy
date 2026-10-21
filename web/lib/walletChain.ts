import type { EIP1193Provider } from 'viem';
import { PAYMENT_RECEIVER_CHAIN as GIWA } from './paymentReceiver';

/**
 * A connected wallet, ready to sign on GIWA Sepolia.
 *
 * Shared by everything a wallet outside Flizy does on the site: paying a pay
 * link, a swap, an NFT trade, a deposit into a Flizy wallet. The wallet signs
 * its own transactions; nothing here touches a Flizy-held key or a session.
 *
 * viem is imported inside the functions, so a page that only shows a Connect
 * button does not carry it.
 */

export { GIWA };

/**
 * FLZ and WETH on GIWA Sepolia (deployments/giwa-sepolia.json, "contracts"),
 * for wallet-mode balances and swap routes in the browser, which cannot import
 * the server's DEX module. test/walletMode.test.js keeps them equal to the record.
 */
export const FLZ_TOKEN = '0x308be8f71DA695f18E70D2243a446e1fD1566BA6';
export const WETH_TOKEN = '0x3a13399f2741122B63c7710B2A85346B97C6BFDf';

/** Ask the wallet to use GIWA Sepolia, adding it first if the wallet does not know it. */
async function ensureGiwa(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: GIWA.hexId }] });
  } catch (err) {
    // 4902: the wallet does not know the chain yet, so it is added, which also switches.
    if ((err as { code?: number })?.code !== 4902) throw err;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: GIWA.hexId,
          chainName: GIWA.name,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [GIWA.rpcUrl],
          blockExplorerUrls: [GIWA.explorerUrl],
        },
      ],
    });
  }
}

/** A wallet client that signs through the connected wallet, and a reader on the public RPC. */
export async function giwaClients(provider: EIP1193Provider, account: `0x${string}`) {
  const viem = await import('viem');
  const chain = viem.defineChain({
    id: GIWA.id,
    name: GIWA.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [GIWA.rpcUrl] } },
    blockExplorers: { default: { name: 'GIWA explorer', url: GIWA.explorerUrl } },
    testnet: true,
  });
  await ensureGiwa(provider);
  return {
    viem,
    wallet: viem.createWalletClient({ account, chain, transport: viem.custom(provider) }),
    reader: viem.createPublicClient({ chain, transport: viem.http(GIWA.rpcUrl) }),
  };
}

/** A wallet's refusal reads plainly; anything else is cut to its first line. */
export function walletErrorText(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : '';
  if (/reject|denied|cancel/i.test(text)) return 'Cancelled in your wallet. Nothing was sent.';
  return text.split('\n')[0].slice(0, 200) || fallback;
}

/** "0x12ab…cdef". */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
