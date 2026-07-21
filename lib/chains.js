/**
 * Chain registry. Adding a chain is a config entry, not a logic change.
 * Launch: GIWA Sepolia (91342). More EVM chains later.
 */

/** @typedef {{
 *  id: string,
 *  name: string,
 *  chainId: number,
 *  rpcUrl: string,
 *  nativeSymbol: string,
 *  explorerBaseUrl: string,
 *  wrappedNative?: string,
 *  dexRouter?: string,
 *  dexFactory?: string,
 *  isDefault?: boolean,
 * }} ChainConfig */

/**
 * Built-in registry. Env can override RPC / explorer per chain.
 * @type {Record<string, ChainConfig>}
 */
const CHAINS = {
  giwa_sepolia: {
    id: 'giwa_sepolia',
    name: 'GIWA Sepolia',
    chainId: 91342,
    rpcUrl: process.env.GIWA_RPC || process.env.CHAIN_GIWA_SEPOLIA_RPC || 'https://sepolia-rpc.giwa.io',
    nativeSymbol: 'ETH',
    explorerBaseUrl: (
      process.env.GIWA_EXPLORER ||
      process.env.CHAIN_GIWA_SEPOLIA_EXPLORER ||
      'https://sepolia-explorer.giwa.io'
    ).replace(/\/$/, ''),
    // Placeholders until Phase 5 trading
    wrappedNative: process.env.CHAIN_GIWA_SEPOLIA_WETH || '',
    dexRouter: process.env.CHAIN_GIWA_SEPOLIA_DEX_ROUTER || '',
    dexFactory: process.env.CHAIN_GIWA_SEPOLIA_DEX_FACTORY || '',
    isDefault: true,
  },
};

/**
 * @param {string} [chainKeyOrId]
 * @returns {ChainConfig}
 */
function getChain(chainKeyOrId) {
  if (!chainKeyOrId) {
    return getDefaultChain();
  }
  const key = String(chainKeyOrId).toLowerCase().trim();
  if (CHAINS[key]) return CHAINS[key];

  const byId = Object.values(CHAINS).find((c) => String(c.chainId) === key || c.id === key);
  if (byId) return byId;

  throw new Error(`Unknown chain: ${chainKeyOrId}`);
}

/** @returns {ChainConfig} */
function getDefaultChain() {
  const fromEnv = process.env.DEFAULT_CHAIN;
  if (fromEnv && CHAINS[fromEnv]) return CHAINS[fromEnv];
  const marked = Object.values(CHAINS).find((c) => c.isDefault);
  if (marked) return marked;
  return Object.values(CHAINS)[0];
}

/** @returns {ChainConfig[]} */
function listChains() {
  return Object.values(CHAINS);
}

/**
 * Explorer URLs from the chain registry only (never hardcode a single explorer).
 * @param {ChainConfig} chain
 * @param {string} txHash
 */
function explorerTxUrl(chain, txHash) {
  const base = (chain.explorerBaseUrl || '').replace(/\/$/, '');
  return `${base}/tx/${txHash}`;
}

/**
 * @param {ChainConfig} chain
 * @param {string} address
 */
function explorerAddressUrl(chain, address) {
  const base = (chain.explorerBaseUrl || '').replace(/\/$/, '');
  return `${base}/address/${address}`;
}

module.exports = {
  CHAINS,
  getChain,
  getDefaultChain,
  listChains,
  explorerTxUrl,
  explorerAddressUrl,
};
