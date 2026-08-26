/**
 * Listed NFT collections for identity send.
 *
 * Same rule as listed tokens: Flizy names the collection. No arbitrary 0x paste.
 * Empty registry is valid; resolve then errors with a clear listed-only message.
 *
 * Env (comma-separated ticker:address):
 *   CHAIN_GIWA_SEPOLIA_NFTS=giwaforge:0xabc...,other:0xdef...
 */

const { ethers } = require('ethers');

const ERC721_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function transferFrom(address from, address to, uint256 tokenId)',
];

/**
 * @param {string} [chainKey]
 * @returns {string}
 */
function nftEnvKey(chainKey) {
  const key = String(chainKey || 'giwa_sepolia')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  return `CHAIN_${key}_NFTS`;
}

/**
 * @param {string} raw
 * @returns {Array<{ ticker: string, address: string }>}
 */
function parseNftRegistry(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const idx = s.indexOf(':');
    if (idx <= 0) continue;
    const ticker = s.slice(0, idx).trim().toLowerCase();
    const addr = s.slice(idx + 1).trim();
    if (!/^[a-z][a-z0-9]{0,31}$/.test(ticker)) continue;
    if (!ethers.isAddress(addr)) continue;
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    out.push({ ticker, address: ethers.getAddress(addr) });
  }
  return out;
}

/**
 * @param {string} [chainKey]
 * @returns {Array<{ ticker: string, address: string }>}
 */
function listedNfts(chainKey) {
  return parseNftRegistry(process.env[nftEnvKey(chainKey)] || '');
}

/**
 * @param {string} [chainKey]
 * @returns {string[]}
 */
function listedNftTickers(chainKey) {
  return listedNfts(chainKey).map((n) => n.ticker);
}

/**
 * @param {string} raw ticker, never a contract paste
 * @param {string} [chainKey]
 * @returns {{ ticker: string, address: string }}
 */
function resolveListedNft(raw, chainKey) {
  const ticker = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '');
  const list = listedNfts(chainKey);
  if (!list.length) {
    throw new Error('No listed collections. Identity NFT send is listed-only.');
  }
  if (!ticker || ethers.isAddress(ticker) || /^0x[a-fA-F0-9]{40}$/.test(String(raw || ''))) {
    throw new Error(`Unknown collection. Listed: ${list.map((n) => n.ticker).join(', ')}.`);
  }
  const found = list.find((n) => n.ticker === ticker);
  if (!found) {
    throw new Error(`Unknown collection ${raw}. Listed: ${list.map((n) => n.ticker).join(', ')}.`);
  }
  return found;
}

/**
 * Canonical uint256 token id as a decimal string (no leading zeros except 0).
 * @param {string|number|null|undefined} raw
 * @returns {string|null}
 */
function normalizeNftTokenId(raw) {
  const s = String(raw == null ? '' : raw)
    .trim()
    .replace(/^#/, '');
  if (!/^[0-9]{1,78}$/.test(s)) return null;
  return s.replace(/^0+(?=\d)/, '') || '0';
}

/**
 * @param {import('ethers').Provider} provider
 * @param {string} collection
 * @param {string} tokenId
 * @param {string} owner
 * @returns {Promise<boolean>}
 */
async function nftOwnedBy(provider, collection, tokenId, owner) {
  if (!provider || !ethers.isAddress(collection) || !ethers.isAddress(owner)) return false;
  const id = normalizeNftTokenId(tokenId);
  if (id == null) return false;
  const nft = new ethers.Contract(collection, ERC721_ABI, provider);
  try {
    const who = await nft.ownerOf(id);
    return ethers.getAddress(who) === ethers.getAddress(owner);
  } catch {
    return false;
  }
}

module.exports = {
  ERC721_ABI,
  nftEnvKey,
  parseNftRegistry,
  listedNfts,
  listedNftTickers,
  resolveListedNft,
  normalizeNftTokenId,
  nftOwnedBy,
};
