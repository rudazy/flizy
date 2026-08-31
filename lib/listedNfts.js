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

const GIWAFORGE_ABI = [
  ...ERC721_ABI,
  'function claimed(address) view returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function MAX_SUPPLY() view returns (uint256)',
  'function claim()',
  'function claimTo(address to)',
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
const DEFAULT_GIWA_SEPOLIA = [
  { ticker: 'giwaforge', address: '0xa613FcF6FE09442391b07F87b82c24a539bCCB2A' },
];

function listedNfts(chainKey) {
  const parsed = parseNftRegistry(process.env[nftEnvKey(chainKey)] || '');
  if (parsed.length) return parsed;
  if (!chainKey || chainKey === 'giwa_sepolia') {
    return DEFAULT_GIWA_SEPOLIA.map((n) => ({
      ticker: n.ticker,
      address: ethers.getAddress(n.address),
    }));
  }
  return [];
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

/**
 * @param {import('ethers').Provider} provider
 * @param {string} collection
 * @param {string} wallet
 */
async function nftClaimedBy(provider, collection, wallet) {
  if (!provider || !ethers.isAddress(collection) || !ethers.isAddress(wallet)) return false;
  const nft = new ethers.Contract(collection, GIWAFORGE_ABI, provider);
  try {
    return Boolean(await nft.claimed(wallet));
  } catch {
    return false;
  }
}

/**
 * Public 1-per-wallet mint. Agent pays gas when it has ETH; otherwise Flizy
 * ops calls claimTo so a new chat account can still receive one.
 *
 * @returns {Promise<{ ok: true, txHash: string, tokenId: string|null, via: 'self'|'ops' } | { ok: false, error: string }>}
 */
async function executeNftMint({
  collection,
  toAddress,
  agentSigner,
  opsWallet,
  provider,
  chain,
  gasBufferEth,
}) {
  if (!ethers.isAddress(collection) || !ethers.isAddress(toAddress)) {
    return { ok: false, error: 'Unknown collection.' };
  }
  const nftView = new ethers.Contract(collection, GIWAFORGE_ABI, provider);
  let supply;
  let cap;
  try {
    if (await nftView.claimed(toAddress)) {
      return { ok: false, error: 'This wallet already minted its one giwaforge.' };
    }
    supply = await nftView.totalSupply();
    cap = await nftView.MAX_SUPPLY();
  } catch {
    return { ok: false, error: 'Could not read that collection. Try again shortly.' };
  }
  if (supply >= cap) {
    return { ok: false, error: 'This collection is fully minted.' };
  }

  const gasBuf = (() => {
    try {
      return ethers.parseEther(String(gasBufferEth || '0.0001'));
    } catch {
      return ethers.parseEther('0.0001');
    }
  })();

  const agentEth = agentSigner
    ? await provider.getBalance(agentSigner.address)
    : 0n;
  const selfPay = Boolean(agentSigner) && agentEth >= gasBuf;
  const signer = selfPay ? agentSigner : opsWallet;
  if (!signer) {
    return {
      ok: false,
      error: [
        'Need a little ETH in your Flizy wallet for gas.',
        `Fund: ${toAddress}`,
      ].join('\n'),
    };
  }
  if (!selfPay) {
    const opsEth = await provider.getBalance(signer.address);
    if (opsEth < gasBuf) {
      return { ok: false, error: 'Mint is temporarily unavailable. Try again shortly.' };
    }
  }

  try {
    const network = await provider.getNetwork();
    if (chain && Number(network.chainId) !== Number(chain.chainId)) {
      return { ok: false, error: 'Wrong network. Try again shortly.' };
    }
    const nft = nftView.connect(signer);
    const tx = selfPay ? await nft.claim() : await nft.claimTo(toAddress);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      return { ok: false, error: 'Mint transaction failed on-chain.' };
    }
    let tokenId = null;
    try {
      const after = await nftView.totalSupply();
      tokenId = String(after);
    } catch {
      tokenId = null;
    }
    return {
      ok: true,
      txHash: tx.hash,
      tokenId,
      via: selfPay ? 'self' : 'ops',
    };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if (/AlreadyClaimed|already minted/i.test(msg)) {
      return { ok: false, error: 'This wallet already minted its one giwaforge.' };
    }
    if (/Cap|fully minted/i.test(msg)) {
      return { ok: false, error: 'This collection is fully minted.' };
    }
    console.error('executeNftMint:', msg);
    return { ok: false, error: 'Could not mint. Try again shortly.' };
  }
}

module.exports = {
  ERC721_ABI,
  GIWAFORGE_ABI,
  nftEnvKey,
  parseNftRegistry,
  listedNfts,
  listedNftTickers,
  resolveListedNft,
  normalizeNftTokenId,
  nftOwnedBy,
  nftClaimedBy,
  executeNftMint,
};
