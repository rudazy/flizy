/**
 * The chain the site runs on, from the environment. On its own, with no
 * imports, so a module that only needs these settings does not load the DEX
 * and wallet code with them. dexServer.ts re-exports it for existing callers.
 */

export type WebChain = {
  id: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  explorerBaseUrl: string;
  nativeSymbol: string;
};

export function getWebChain(): WebChain {
  return {
    id: 'giwa_sepolia',
    name: 'GIWA Sepolia',
    chainId: Number(process.env.GIWA_CHAIN_ID || 91342),
    rpcUrl: process.env.GIWA_RPC || process.env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io',
    explorerBaseUrl: (
      process.env.GIWA_EXPLORER ||
      process.env.CHAIN_GIWA_SEPOLIA_EXPLORER ||
      'https://sepolia-explorer.giwa.io'
    ).replace(/\/$/, ''),
    nativeSymbol: 'ETH',
  };
}
