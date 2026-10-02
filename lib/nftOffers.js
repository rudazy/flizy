/**
 * Offers on a person's NFTs, for "flizy accept offer" in chat.
 *
 * The site tells an NFT's owner about a new offer (web/lib/offerNotice.ts) and
 * points them here. Chat then lists the open offers on NFTs the wallet still
 * holds, newest first, and sells into the one picked. Offers are found from the
 * marketplace's own events through the explorer, and every candidate is re-read
 * from the chain before it is shown: the offer must still be open and
 * unexpired, and the wallet must still own the NFT. Offers the owner declined on
 * the site (nft_offer_declines) are left out.
 *
 * Same contract and rules as web/app/api/market/[action]/route.ts: the 2% Flizy
 * fee, the creator royalty with the seller's ceiling, per-token approval.
 */

const { ethers } = require('ethers');

const MARKET_ABI = [
  'event OfferMade(uint256 indexed offerId, address indexed collection, address indexed maker, uint256 tokenId, bool anyToken, uint256 amount, uint64 expiry)',
  'event OfferCancelled(uint256 indexed offerId, address indexed maker)',
  'event Sold(address indexed collection, uint256 indexed tokenId, address indexed buyer, address seller, uint256 price, uint256 fee, uint256 royalty, uint256 offerId)',
  'function getOffer(uint256 offerId) view returns (tuple(address maker, uint64 expiry, bool anyToken, address collection, uint256 tokenId, uint256 amount))',
  'function royaltyFor(address collection, uint256 tokenId, uint256 price) view returns (address receiver, uint256 amount)',
  'function acceptOffer(uint256 offerId, uint256 tokenId, uint256 expectedAmount, uint256 maxRoyaltyBps)',
  'function paused() view returns (bool)',
];
const NFT_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function getApproved(uint256) view returns (address)',
  'function approve(address to, uint256 tokenId)',
  'function name() view returns (string)',
];
const MARKET_IFACE = new ethers.Interface(MARKET_ABI);
const NFT_IFACE = new ethers.Interface(NFT_ABI);

/** Must match FlizyMarketplace.FEE_BPS. test/nftOffersChat.test.js reads the contract to keep them equal. */
const FEE_BPS = 200n;
const BPS = 10_000n;
const MAX_LOG_PAGES = 20;
const MAX_WALLET_PAGES = 3;
const MAX_CANDIDATES = 50;
/** How many offers chat lists at once; the site shows the rest. */
const MAX_LISTED = 9;

/** The deployed marketplace, or null when none is configured (chat offers off). */
function marketConfig(env = process.env) {
  const raw = env.CHAIN_GIWA_SEPOLIA_MARKETPLACE;
  if (!raw || !ethers.isAddress(raw)) return null;
  const from = Number(env.CHAIN_GIWA_SEPOLIA_MARKETPLACE_FROM_BLOCK || 0);
  return { address: ethers.getAddress(raw), fromBlock: Number.isSafeInteger(from) && from > 0 ? from : 0 };
}

/** Explorer log rows -> { topics, data, blockNumber, logIndex }, skipping anything malformed. */
function parseLogRows(body) {
  const items = body && Array.isArray(body.items) ? body.items : [];
  const out = [];
  for (const row of items) {
    if (!row || !Array.isArray(row.topics)) continue;
    const topics = row.topics.filter((t) => typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t));
    if (!topics.length || typeof row.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(row.data)) continue;
    if (!Number.isSafeInteger(row.block_number) || !Number.isSafeInteger(row.index)) continue;
    out.push({ topics, data: row.data, blockNumber: row.block_number, logIndex: row.index });
  }
  return out;
}

/**
 * Open single-token offers, newest first, from decoded marketplace events.
 * Collection offers are left out: chat names one NFT, and the site is where a
 * collection offer is matched to a token.
 */
function openTokenOffers(logs) {
  const events = [];
  for (const log of logs) {
    let parsed = null;
    try {
      parsed = MARKET_IFACE.parseLog({ topics: log.topics, data: log.data });
    } catch {
      parsed = null;
    }
    if (parsed) events.push({ parsed, blockNumber: log.blockNumber, logIndex: log.logIndex });
  }
  events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const open = new Map();
  for (const { parsed, blockNumber } of events) {
    const a = parsed.args;
    if (parsed.name === 'OfferMade') {
      if (a.anyToken) continue;
      open.set(a.offerId.toString(), {
        offerId: a.offerId.toString(),
        collection: ethers.getAddress(a.collection),
        tokenId: a.tokenId.toString(),
        maker: ethers.getAddress(a.maker),
        amount: BigInt(a.amount),
        expiry: Number(a.expiry),
        blockNumber,
      });
    } else if (parsed.name === 'OfferCancelled') {
      open.delete(a.offerId.toString());
    } else if (parsed.name === 'Sold' && a.offerId.toString() !== '0') {
      open.delete(a.offerId.toString());
    }
  }
  return [...open.values()].sort((x, y) => y.blockNumber - x.blockNumber);
}

async function readLogs(explorerBaseUrl, market, fetcher) {
  const base = `${String(explorerBaseUrl).replace(/\/$/, '')}/api/v2/addresses/${market.address}/logs`;
  if (!/^https:\/\//.test(base)) throw new Error('offers need an https explorer');
  const logs = [];
  let query = '';
  for (let page = 0; page < MAX_LOG_PAGES; page += 1) {
    const res = await fetcher(`${base}${query}`);
    if (!res.ok) throw new Error('offers unavailable');
    const body = await res.json();
    const rows = parseLogRows(body).filter((l) => l.blockNumber >= market.fromBlock);
    logs.push(...rows);
    const next = body && body.next_page_params;
    const oldest = rows.length ? rows[rows.length - 1].blockNumber : 0;
    if (!next || typeof next !== 'object' || oldest < market.fromBlock) break;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) {
      if (/^[A-Za-z_]{1,40}$/.test(k) && (typeof v === 'number' || typeof v === 'string')) params.set(k, String(v));
    }
    query = `?${params.toString()}`;
  }
  return logs;
}

/** Token keys ("collection:tokenId", lowercase collection) the wallet holds, per the explorer. */
async function readHeldTokens(explorerBaseUrl, wallet, fetcher) {
  const base = `${String(explorerBaseUrl).replace(/\/$/, '')}/api/v2/addresses/${wallet}/nft`;
  if (!/^https:\/\//.test(base)) throw new Error('offers need an https explorer');
  const held = new Set();
  let query = '?type=ERC-721';
  for (let page = 0; page < MAX_WALLET_PAGES; page += 1) {
    const res = await fetcher(`${base}${query}`);
    if (!res.ok) throw new Error('wallet NFTs unavailable');
    const body = await res.json();
    for (const item of body && Array.isArray(body.items) ? body.items : []) {
      const collection = item && item.token && item.token.address_hash;
      const id = item && item.id;
      if (typeof collection === 'string' && ethers.isAddress(collection) && typeof id === 'string' && /^[0-9]{1,78}$/.test(id)) {
        held.add(`${collection.toLowerCase()}:${BigInt(id).toString()}`);
      }
    }
    const next = body && body.next_page_params;
    if (!next || typeof next !== 'object') break;
    const params = new URLSearchParams({ type: 'ERC-721' });
    for (const [k, v] of Object.entries(next)) {
      if (/^[A-Za-z_]{1,40}$/.test(k) && (typeof v === 'number' || typeof v === 'string')) params.set(k, String(v));
    }
    query = `?${params.toString()}`;
  }
  return held;
}

/**
 * Open offers on NFTs `wallet` owns, newest first, re-checked on chain, at most
 * MAX_LISTED, and how many there are in all. `declined` holds offer ids the
 * owner declined on the site.
 *
 * @returns {Promise<{ offers: object[], count: number }>}
 */
async function findOffersToAccept({
  provider,
  explorerBaseUrl,
  market,
  wallet,
  declined = new Set(),
  now = Date.now(),
  fetcher = defaultFetch,
}) {
  const owner = ethers.getAddress(wallet);
  const contract = new ethers.Contract(market.address, MARKET_ABI, provider);
  // The wallet's NFTs first, so the newest offers anywhere in the market cannot
  // crowd out older offers on this wallet's own NFTs.
  const [logs, held] = await Promise.all([
    readLogs(explorerBaseUrl, market, fetcher),
    readHeldTokens(explorerBaseUrl, owner, fetcher),
  ]);
  const candidates = openTokenOffers(logs)
    .filter(
      (o) =>
        o.maker !== owner &&
        !declined.has(o.offerId) &&
        held.has(`${o.collection.toLowerCase()}:${o.tokenId}`)
    )
    .slice(0, MAX_CANDIDATES);
  const nowSec = Math.floor(now / 1000);
  const live = [];
  for (const c of candidates) {
    if (c.expiry < nowSec) continue;
    const nft = new ethers.Contract(c.collection, NFT_ABI, provider);
    const [held, onChain] = await Promise.all([
      nft.ownerOf(c.tokenId).then((a) => ethers.getAddress(a)).catch(() => null),
      contract.getOffer(c.offerId).catch(() => null),
    ]);
    if (held !== owner || !onChain || onChain.maker === ethers.ZeroAddress) continue;
    if (BigInt(onChain.amount) !== c.amount || Number(onChain.expiry) < nowSec) continue;
    live.push(c);
  }
  return { offers: live.slice(0, MAX_LISTED), count: live.length };
}

/**
 * The split a sale at `amount` pays, as the contract will pay it, and the
 * royalty ceiling (rounded up) the seller agrees to by confirming.
 */
async function quoteAccept({ provider, market, offer }) {
  const contract = new ethers.Contract(market.address, MARKET_ABI, provider);
  const [, royaltyRaw] = await contract.royaltyFor(offer.collection, offer.tokenId, offer.amount);
  const royalty = BigInt(royaltyRaw);
  const fee = (offer.amount * FEE_BPS) / BPS;
  const maxRoyaltyBps = offer.amount > 0n ? (royalty * BPS + offer.amount - 1n) / offer.amount : 0n;
  return { fee, royalty, sellerGets: offer.amount - fee - royalty, maxRoyaltyBps };
}

/** The transactions to send: approve this one token if needed, then accept. */
async function acceptCalls({ provider, market, offer, maxRoyaltyBps }) {
  const nft = new ethers.Contract(offer.collection, NFT_ABI, provider);
  const approved = await nft.getApproved(offer.tokenId).catch(() => null);
  const calls = [];
  if (!approved || ethers.getAddress(approved) !== market.address) {
    calls.push({ target: offer.collection, value: 0n, data: NFT_IFACE.encodeFunctionData('approve', [market.address, offer.tokenId]) });
  }
  calls.push({
    target: market.address,
    value: 0n,
    data: MARKET_IFACE.encodeFunctionData('acceptOffer', [offer.offerId, offer.tokenId, offer.amount, maxRoyaltyBps]),
  });
  return calls;
}

async function collectionName(provider, collection) {
  const nft = new ethers.Contract(collection, NFT_ABI, provider);
  const name = await nft.name().catch(() => null);
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 40) : `${collection.slice(0, 6)}...${collection.slice(-4)}`;
}

function defaultFetch(url) {
  return fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
}

module.exports = {
  FEE_BPS,
  marketConfig,
  parseLogRows,
  openTokenOffers,
  findOffersToAccept,
  quoteAccept,
  acceptCalls,
  collectionName,
  MARKET_IFACE,
};
