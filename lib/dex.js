/**
 * DEX swap helpers (Phase 5). Uniswap V2-style router interface.
 * Router address comes from chain registry. No hardcoding of explorers.
 */

const { ethers } = require('ethers');
const { getChain } = require('./chains');

const UNISWAP_V2_ROUTER_ABI = [
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
  'function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)',
  'function WETH() view returns (address)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
];

/**
 * @param {import('ethers').Signer} signer
 * @param {string} [chainKey]
 */
function getRouter(signer, chainKey) {
  const chain = getChain(chainKey);
  if (!chain.dexRouter) {
    throw new Error(`No DEX router configured for chain ${chain.id}`);
  }
  return {
    chain,
    router: new ethers.Contract(chain.dexRouter, UNISWAP_V2_ROUTER_ABI, signer),
  };
}

/**
 * Quote and build a buy-with-native path: native -> token.
 * @returns {Promise<{ amounts: bigint[], path: string[], chain: object }>}
 */
async function quoteBuyToken(provider, tokenAddress, amountInWei, chainKey) {
  const chain = getChain(chainKey);
  if (!chain.dexRouter || !chain.wrappedNative) {
    throw new Error(`DEX not configured for ${chain.id}. Set router and wrapped native in env.`);
  }
  const router = new ethers.Contract(chain.dexRouter, UNISWAP_V2_ROUTER_ABI, provider);
  const path = [chain.wrappedNative, tokenAddress];
  const amounts = await router.getAmountsOut(amountInWei, path);
  return { amounts, path, chain };
}

/**
 * @param {import('ethers').Wallet} wallet
 */
async function buyTokenWithNative(wallet, tokenAddress, amountInWei, amountOutMin, to, chainKey) {
  const { router, chain } = getRouter(wallet, chainKey);
  if (!chain.wrappedNative) throw new Error('wrappedNative missing');
  const path = [chain.wrappedNative, tokenAddress];
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  const tx = await router.swapExactETHForTokens(amountOutMin, path, to, deadline, {
    value: amountInWei,
  });
  return tx;
}

async function getTokenMeta(provider, tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
  return { decimals: Number(decimals), symbol: String(symbol) };
}

module.exports = {
  UNISWAP_V2_ROUTER_ABI,
  ERC20_ABI,
  getRouter,
  quoteBuyToken,
  buyTokenWithNative,
  getTokenMeta,
};
