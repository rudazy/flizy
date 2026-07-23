/**
 * Token holdings for an agent wallet.
 * Native balance always. Optional ERC-20 list via env until DEX discovery is live.
 *
 * TRACKED_TOKENS format (comma-separated):
 *   0xToken:SYMBOL:decimals,0xOther:USDC:6
 */

const { ethers } = require('ethers');
const { getDefaultChain } = require('./chains');

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

  return {
    chain: { id: c.id, name: c.name, chainId: c.chainId, explorerBaseUrl: c.explorerBaseUrl },
    native,
    tokens,
    note:
      tokens.length === 0
        ? 'Native balance shown. More tokens appear when TRACKED_TOKENS is set or DEX is live.'
        : null,
  };
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
  } else if (holdings?.note) {
    lines.push('', holdings.note);
  }
  lines.push('', 'Sends are from your agent wallet (fund it on GIWA Sepolia).');
  lines.push('Send tokens: flizy send 10 FLZ to name (trusted only).');
  lines.push('Swap: flizy buy 0.01 FLZ · flizy sell 10 FLZ');
  if (agentWallet && holdings?.chain?.explorerBaseUrl) {
    const base = holdings.chain.explorerBaseUrl.replace(/\/$/, '');
    lines.push(`${base}/address/${agentWallet}`);
  }
  return lines.join('\n');
}

module.exports = {
  parseTrackedTokens,
  getWalletHoldings,
  formatHoldingsMessage,
};
