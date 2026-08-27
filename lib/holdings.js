/**
 * Token holdings for an agent wallet.
 * Native balance always. Optional ERC-20 list via env until DEX discovery is live.
 *
 * TRACKED_TOKENS format (comma-separated):
 *   0xToken:SYMBOL:decimals,0xOther:USDC:6
 */

const { ethers } = require('ethers');
const { getDefaultChain } = require('./chains');
const { listedNfts } = require('./listedNfts');

const ERC721_META_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function totalSupply() view returns (uint256)',
];

/**
 * Hard ceiling on ids probed per collection, whatever totalSupply claims.
 * Listed collections are small by policy (giwaforge caps at 500); this keeps a
 * future listing from turning one balance read into thousands of RPC calls.
 */
const MAX_ID_SCAN = 600;

/** Ids per batched round trip. Matches the ethers JSON-RPC batch default. */
const ID_SCAN_CHUNK = 100;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

function parseTrackedTokens(chain) {
  const list = [];
  // Always track FLZ when configured on the chain registry
  const flz = chain?.flzToken || process.env.CHAIN_GIWA_SEPOLIA_FLZ || '';
  if (flz && ethers.isAddress(flz)) {
    list.push({ address: ethers.getAddress(flz), symbol: 'FLZ', decimals: 18 });
  }
  const raw = process.env.TRACKED_TOKENS || process.env.CHAIN_GIWA_SEPOLIA_TOKENS || '';
  if (raw.trim()) {
    for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
      const [address, symbol, decimals] = part.split(':');
      if (!address || !ethers.isAddress(address)) continue;
      const addr = ethers.getAddress(address);
      if (list.some((t) => t.address === addr)) continue;
      list.push({
        address: addr,
        symbol: symbol || 'TOKEN',
        decimals: decimals != null && decimals !== '' ? Number(decimals) : null,
      });
    }
  }
  return list;
}

/**
 * @param {string} walletAddress
 * @param {import('./chains').ChainConfig} [chain]
 */
async function getWalletHoldings(walletAddress, chain) {
  const c = chain || getDefaultChain();
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    return { chain: c, native: null, tokens: [], note: 'No agent wallet yet' };
  }

  const provider = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId);
  const address = ethers.getAddress(walletAddress);

  const nativeWei = await provider.getBalance(address);
  const native = {
    symbol: c.nativeSymbol || 'ETH',
    balance: ethers.formatEther(nativeWei),
    balanceWei: nativeWei.toString(),
    address: null,
  };

  const tracked = parseTrackedTokens(c);
  const tokens = [];

  for (const t of tracked) {
    try {
      const contract = new ethers.Contract(t.address, ERC20_ABI, provider);
      const [bal, dec, sym] = await Promise.all([
        contract.balanceOf(address),
        t.decimals != null ? Promise.resolve(t.decimals) : contract.decimals(),
        t.symbol ? Promise.resolve(t.symbol) : contract.symbol(),
      ]);
      const decimals = Number(dec);
      tokens.push({
        symbol: String(sym),
        address: t.address,
        balance: ethers.formatUnits(bal, decimals),
        balanceRaw: bal.toString(),
        decimals,
      });
    } catch {
      tokens.push({
        symbol: t.symbol || 'TOKEN',
        address: t.address,
        balance: null,
        error: 'Could not read token',
      });
    }
  }

  const nfts = await loadNftHoldings(provider, address, c.id);

  return {
    chain: { id: c.id, name: c.name, chainId: c.chainId, explorerBaseUrl: c.explorerBaseUrl },
    native,
    tokens,
    nfts,
    note:
      tokens.length === 0 && !nfts.length
        ? 'Native balance shown. More tokens appear when TRACKED_TOKENS is set or DEX is live.'
        : null,
  };
}

/**
 * Token ids of `wallet` in one listed collection.
 *
 * Deliberately NOT a Transfer-log scan. The GIWA Sepolia RPC caps eth_getLogs
 * at a 100k block range and the chain is past 34M blocks, so the unbounded
 * queryFilter this used to run always came back
 * `-32602 query exceeds max block range`. Every holder then looked like
 * "balance 1, ids []", which is what made `send giwaforge to ...` dead-end with
 * "could not list token ids".
 *
 * Listed collections mint sequential ids and cap in the hundreds, so probing
 * ownerOf over 0..totalSupply is exact, needs no log retention, and costs a
 * handful of batched calls. Ids are probed from 0 so a 0-indexed collection is
 * covered as well as giwaforge's 1-indexed mint. The scan stops as soon as it
 * has `count` ids, so the usual one-NFT wallet costs one round trip.
 *
 * Degrades to [] rather than throwing: a missing id list still leaves the
 * count, and callers ask for an explicit id in that case.
 *
 * @param {import('ethers').Contract} nft
 * @param {string} wallet
 * @param {number} count balanceOf, already read
 * @returns {Promise<string[]>} ascending decimal ids
 */
async function scanOwnedTokenIds(nft, wallet, count) {
  let supply;
  try {
    supply = Number(await nft.totalSupply());
  } catch {
    return [];
  }
  if (!Number.isFinite(supply) || supply <= 0) return [];

  const owner = String(wallet).toLowerCase();
  const last = Math.min(supply, MAX_ID_SCAN);
  const found = [];

  for (let start = 0; start <= last && found.length < count; start += ID_SCAN_CHUNK) {
    const chunk = [];
    for (let id = start; id < start + ID_SCAN_CHUNK && id <= last; id += 1) chunk.push(id);
    // ownerOf reverts for ids that were never minted; that is a miss, not a failure.
    const owners = await Promise.all(
      chunk.map((id) => nft.ownerOf(id).then((who) => String(who), () => null))
    );
    for (let i = 0; i < chunk.length; i += 1) {
      if (owners[i] && owners[i].toLowerCase() === owner) found.push(String(chunk[i]));
    }
  }

  return found;
}

/**
 * @param {import('ethers').Provider} provider
 * @param {string} wallet
 * @param {string} [chainKey]
 */
async function loadNftHoldings(provider, wallet, chainKey) {
  const out = [];
  for (const col of listedNfts(chainKey)) {
    try {
      const nft = new ethers.Contract(col.address, ERC721_META_ABI, provider);
      const bal = await nft.balanceOf(wallet);
      const count = Number(bal);
      // A listed collection you hold none of is not a holding. Reporting
      // "giwaforge: 0" reads like you own something; the caller wants the list
      // to be what is actually in the wallet, and an empty list is the honest
      // answer. A collection that could not be READ is different and still
      // reported below, so "none" is never confused with "do not know".
      if (!Number.isFinite(count) || count <= 0) continue;
      const ids = await scanOwnedTokenIds(nft, wallet, count);
      out.push({
        ticker: col.ticker,
        address: col.address,
        balance: String(count),
        ids,
      });
    } catch {
      out.push({
        ticker: col.ticker,
        address: col.address,
        balance: null,
        ids: [],
        error: 'Could not read NFT',
      });
    }
  }
  return out;
}

/** Ids listed inline in a balance before the line is summarised. */
const NFT_IDS_SHOWN = 10;

function formatNftHoldingLine(n) {
  if (!n) return '';
  if (n.balance == null) return `${n.ticker}: unavailable`;
  if (Array.isArray(n.ids) && n.ids.length) {
    const shown = n.ids.slice(0, NFT_IDS_SHOWN).map((id) => `#${id}`).join(', ');
    const rest = n.ids.length - NFT_IDS_SHOWN;
    return rest > 0 ? `${n.ticker} ${shown} +${rest} more` : `${n.ticker} ${shown}`;
  }
  return `${n.ticker}: ${n.balance}`;
}

/**
 * WhatsApp-friendly multi-line summary.
 */
function formatHoldingsMessage({ credit, agentWallet, holdings, showCredit }) {
  const lines = ['Your balances', ''];
  if (showCredit) {
    lines.push(`Ledger credit: ${credit} ETH`);
  }
  if (agentWallet) {
    lines.push(`Agent wallet: ${agentWallet}`);
  }
  if (holdings?.native) {
    lines.push(
      `${holdings.native.symbol} (on-chain): ${Number(holdings.native.balance).toFixed(6)}`
    );
  }
  if (holdings?.tokens?.length) {
    lines.push('', 'Tokens:');
    for (const t of holdings.tokens) {
      if (t.balance == null) {
        lines.push(`  ${t.symbol}: unavailable`);
      } else {
        const n = Number(t.balance);
        lines.push(`  ${t.symbol}: ${n === 0 ? '0' : n.toPrecision(6)}`);
      }
    }
  }
  if (holdings?.nfts?.length) {
    lines.push('', 'NFTs:');
    for (const n of holdings.nfts) {
      lines.push(`  ${formatNftHoldingLine(n)}`);
    }
  } else if (holdings?.note && !holdings?.tokens?.length) {
    lines.push('', holdings.note);
  }
  lines.push('', 'Sends are from your agent wallet (fund it on GIWA Sepolia).');
  lines.push('Send tokens: flizy send 10 FLZ to name (trusted only).');
  lines.push('Send NFT: flizy send giwaforge to you@email.com  (picks the token id if you hold more than one)');
  lines.push('Swap: flizy buy 0.01 FLZ · flizy sell 10 FLZ');
  if (agentWallet && holdings?.chain?.explorerBaseUrl) {
    const base = holdings.chain.explorerBaseUrl.replace(/\/$/, '');
    lines.push(`${base}/address/${agentWallet}`);
  }
  return lines.join('\n');
}

/**
 * What this wallet holds for one ticker: listed ERC-20 and/or listed NFT.
 * Used when the user types `send giwaforge to ...` without an amount or token id.
 *
 * @param {string} walletAddress
 * @param {string} ticker
 * @param {import('./chains').ChainConfig} [chain]
 * @returns {Promise<{
 *   ticker: string,
 *   token: { symbol: string, balance: string, native?: boolean } | null,
 *   nft: { ticker: string, ids: string[], balance: string } | null,
 * }>}
 */
async function lookupNamedAssetHoldings(walletAddress, ticker, chain) {
  const want = String(ticker || '')
    .trim()
    .toLowerCase();
  const empty = { ticker: want, token: null, nft: null };
  if (!want) return empty;

  const holdings = await getWalletHoldings(walletAddress, chain);
  const nativeSym = String(holdings?.native?.symbol || 'ETH').toLowerCase();
  if (
    holdings?.native &&
    (want === nativeSym || want === 'eth' || want === 'ether' || want === 'native')
  ) {
    const bal = Number(holdings.native.balance);
    if (Number.isFinite(bal) && bal > 0) {
      empty.token = {
        symbol: holdings.native.symbol || 'ETH',
        balance: String(holdings.native.balance),
        native: true,
      };
    }
  }

  for (const t of holdings?.tokens || []) {
    if (String(t.symbol || '').toLowerCase() !== want) continue;
    if (t.balance == null) continue;
    const n = Number(t.balance);
    if (!Number.isFinite(n) || n <= 0) continue;
    empty.token = { symbol: String(t.symbol), balance: String(t.balance), native: false };
    break;
  }

  for (const n of holdings?.nfts || []) {
    if (String(n.ticker || '').toLowerCase() !== want) continue;
    const count = Number(n.balance);
    if (!Number.isFinite(count) || count <= 0) continue;
    empty.nft = {
      ticker: n.ticker,
      ids: Array.isArray(n.ids) ? n.ids.map((id) => String(id)) : [],
      balance: String(n.balance),
    };
    break;
  }

  return empty;
}

module.exports = {
  parseTrackedTokens,
  getWalletHoldings,
  loadNftHoldings,
  scanOwnedTokenIds,
  lookupNamedAssetHoldings,
  formatNftHoldingLine,
  formatHoldingsMessage,
};
