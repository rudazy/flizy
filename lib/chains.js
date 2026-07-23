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
 *  feeRouter?: string,
 *  flzToken?: string,
 *  flzWethPair?: string,
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
    // Flizy DEX (Uniswap V2 fork + fee router). Env overrides deployments/giwa-sepolia.json.
    wrappedNative:
      process.env.CHAIN_GIWA_SEPOLIA_WETH || '0x3a13399f2741122B63c7710B2A85346B97C6BFDf',
    dexRouter:
      process.env.CHAIN_GIWA_SEPOLIA_DEX_ROUTER || '0x4055413A4757e069bbCAc481639EF2814224Faa0',
    dexFactory:
      process.env.CHAIN_GIWA_SEPOLIA_DEX_FACTORY || '0xBB1d2c582E455B448660A199097A54DF29162BbF',
    feeRouter:
      process.env.CHAIN_GIWA_SEPOLIA_FEE_ROUTER || '0x6427fD0c13577847888B7E2d1A24C887bBEBd9cC',
    flzToken:
      process.env.CHAIN_GIWA_SEPOLIA_FLZ || '0x308be8f71DA695f18E70D2243a446e1fD1566BA6',
    flzWethPair:
      process.env.CHAIN_GIWA_SEPOLIA_FLZ_WETH_PAIR || '0xEC6Ebf4A7a3088EB22535C9F767B9Ab5845D8227',
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
